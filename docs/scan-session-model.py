# -*- coding: utf-8 -*-
"""只读扫描 dsh 会话文件（session.jsonl.zstd），提取模型相关字段与 agentId。

用法: python docs/scan-session-model.py <session.jsonl.zstd> [更多文件...]
约束: 只读；不输出消息正文；仅输出字段路径、模型取值、agentId、类型计数。
zstd 解压走本机 libzstd.dll（D:\\Git\\mingw64\\bin\\libzstd.dll，Git 自带），
不安装任何依赖。
"""
import ctypes
import json
import sys
from collections import Counter, defaultdict

LIB = r"D:\Git\mingw64\bin\libzstd.dll"


class ZSTD_inBuffer(ctypes.Structure):
    _fields_ = [("src", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]


class ZSTD_outBuffer(ctypes.Structure):
    _fields_ = [("dst", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]


_z = ctypes.CDLL(LIB)
_z.ZSTD_createDStream.restype = ctypes.c_void_p
_z.ZSTD_freeDStream.argtypes = [ctypes.c_void_p]
_z.ZSTD_initDStream.argtypes = [ctypes.c_void_p]
_z.ZSTD_initDStream.restype = ctypes.c_size_t
_z.ZSTD_decompressStream.argtypes = [ctypes.c_void_p, ctypes.POINTER(ZSTD_outBuffer), ctypes.POINTER(ZSTD_inBuffer)]
_z.ZSTD_decompressStream.restype = ctypes.c_size_t
_z.ZSTD_isError.argtypes = [ctypes.c_size_t]
_z.ZSTD_isError.restype = ctypes.c_uint


def zstd_decompress_all(data: bytes) -> bytes:
    dstream = _z.ZSTD_createDStream()
    if not dstream:
        raise RuntimeError("ZSTD_createDStream failed")
    _z.ZSTD_initDStream(dstream)
    src_buf = ctypes.create_string_buffer(data, len(data))
    inbuf = ZSTD_inBuffer(ctypes.cast(src_buf, ctypes.c_void_p), len(data), 0)
    out = bytearray()
    cap = 1 << 23  # 8 MB 起步，不够翻倍
    try:
        while True:
            dst_buf = ctypes.create_string_buffer(cap)
            outbuf = ZSTD_outBuffer(ctypes.cast(dst_buf, ctypes.c_void_p), cap, 0)
            while True:
                rc = _z.ZSTD_decompressStream(dstream, ctypes.byref(outbuf), ctypes.byref(inbuf))
                if _z.ZSTD_isError(rc):
                    raise RuntimeError(f"zstd error code {rc}")
                if outbuf.pos == outbuf.size:
                    break  # 输出缓冲满，扩容
                if rc == 0 and inbuf.pos == inbuf.size:
                    out += dst_buf.raw[: outbuf.pos]
                    return bytes(out)
                if rc == 0:  # 帧结束但还有输入 → 初始化下一帧
                    _z.ZSTD_initDStream(dstream)
                if rc > 0 and inbuf.pos == inbuf.size:
                    raise RuntimeError("truncated stream (file still being written?)")
            out += dst_buf.raw[: outbuf.pos]
            cap *= 2
            if cap > (1 << 28):
                raise RuntimeError("decompressed output exceeds 256 MB")
    finally:
        _z.ZSTD_freeDStream(dstream)


def walk(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            yield p, v
            yield from walk(v, p)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, f"{path}[{i}]")


def scan(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = zstd_decompress_all(raw).decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]

    type_counts = Counter()
    agent_ids = Counter()          # agentId -> 出现行数
    model_values = Counter()       # 所有 model* 字段取值 -> 次数
    model_paths = Counter()        # 字段路径 -> 次数
    msg_model_by_agent = defaultdict(lambda: defaultdict(Counter))  # type -> agentId -> model -> count
    per_type_agent = defaultdict(Counter)

    for ln in lines:
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError:
            continue
        typ = obj.get("type", "(none)")
        type_counts[typ] += 1
        for p, v in walk(obj):
            key = p.rsplit(".", 1)[-1].split("[")[0]
            if key == "agentId" and isinstance(v, str):
                agent_ids[v] += 1
                per_type_agent[typ][v] += 1
            if "model" in key.lower():
                if isinstance(v, (str, int)):
                    model_values[v] += 1
                    model_paths[p] += 1
                    if typ in ("assistant/message", "assistant/message/chunk"):
                        aid = None
                        if isinstance(obj.get("data"), dict):
                            aid = obj["data"].get("agentId")
                        msg_model_by_agent[typ][f"{aid}"] [v] += 1

    print(f"== {path}")
    print(f"   压缩大小 {len(raw):,} B / 解压 {len(text):,} 字符 / {len(lines)} 行")
    print(f"   类型计数: {dict(type_counts.most_common(20))}")
    print(f"   agentId 出现分布(按行): {dict(agent_ids)}")
    print(f"   各类型 × agentId: {dict(per_type_agent)}")
    print(f"   model* 字段取值分布: {dict(model_values)}")
    if msg_model_by_agent:
        print(f"   assistant 消息 × agentId × source.model:")
        for typ, by_agent in msg_model_by_agent.items():
            for aid, mc in by_agent.items():
                print(f"      {typ} agentId={aid}: {dict(mc)}")
    # 列出 model 字段路径示例（仅前 12 种，避免刷屏）
    top_paths = ", ".join(f"{p}×{n}" for p, n in model_paths.most_common(12))
    print(f"   model 字段路径(前12): {top_paths}")
    print()


def preview(path):
    """摘要预览：会话元数据 + 用户/助手消息文本前 N 字符 + 工具调用名。"""
    with open(path, "rb") as f:
        raw = f.read()
    text = zstd_decompress_all(raw).decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]

    def cap(s, n=160):
        s = " ".join(str(s).split())
        return s if len(s) <= n else s[:n] + "…"

    print(f"== {path}")
    for ln in lines:
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError:
            continue
        typ = obj.get("type", "(none)")
        data = obj.get("data") or {}
        if typ == "session":
            print(f"  [{typ}] {json.dumps({k: v for k, v in data.items() if k not in ('events',)}, ensure_ascii=False)[:300]}")
        elif typ in ("session/title", "permission/preset", "sandbox/mode", "approval/policy", "subagent/descriptor"):
            print(f"  [{typ}] {json.dumps(data, ensure_ascii=False)[:300]}")
        elif typ == "request/header":
            h = data.get("header", data)
            cfg = h.get("config", {}) if isinstance(h, dict) else {}
            print(f"  [request/header] model={cfg.get('model')} preset={cfg.get('agentPreset') or cfg.get('preset')} extra={json.dumps({k: v for k, v in (cfg.items() if isinstance(cfg, dict) else []) if k not in ('model', 'tools')}, ensure_ascii=False)[:200]}")
        elif typ == "user/message":
            blocks = data.get("message", {}).get("content", []) if isinstance(data.get("message"), dict) else []
            texts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
            joined = " ".join(texts)
            print(f"  [user/message] {cap(joined, 200)}")
        elif typ == "assistant/message":
            m = data.get("message", {})
            blocks = m.get("content", []) if isinstance(m, dict) else []
            texts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
            src = m.get("source", {}) if isinstance(m, dict) else {}
            print(f"  [assistant/message] model={src.get('model')} {cap(' '.join(texts), 160)}")
        elif typ == "tool/call":
            t = data.get("tool") or data
            name = t.get("name") if isinstance(t, dict) else None
            args = t.get("arguments", {}) if isinstance(t, dict) else {}
            brief = ""
            if isinstance(args, dict):
                brief = cap(json.dumps({k: v for k, v in args.items() if k in ("description", "run_in_background")}, ensure_ascii=False), 120)
            print(f"  [tool/call] name={name} {brief}")
    print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == "--preview":
        for p in sys.argv[2:]:
            preview(p)
    else:
        for p in sys.argv[1:]:
            scan(p)
