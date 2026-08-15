# -*- coding: utf-8 -*-
"""锚定形态取证：读取 dsh 会话文件，输出每轮的工具目录与 thinking 开头。

用法: python docs/scan-session-anchor.py <session.jsonl.zstd> [--struct]
--struct: 只打印 request/header 与 reasoning-chunks 的首条原始结构（探查用）
只读；不输出消息正文（仅 thinking 前 60 字符与工具名列表）。
zstd 解压走本机 libzstd.dll（容错：文件仍在写入时容忍尾帧截断）。
"""
import ctypes
import json
import sys

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
    cap = 1 << 23
    try:
        while True:
            dst_buf = ctypes.create_string_buffer(cap)
            outbuf = ZSTD_outBuffer(ctypes.cast(dst_buf, ctypes.c_void_p), cap, 0)
            while True:
                rc = _z.ZSTD_decompressStream(dstream, ctypes.byref(outbuf), ctypes.byref(inbuf))
                if _z.ZSTD_isError(rc):
                    out += dst_buf.raw[: outbuf.pos]
                    return bytes(out)
                if outbuf.pos == outbuf.size:
                    break
                if rc == 0 and inbuf.pos == inbuf.size:
                    out += dst_buf.raw[: outbuf.pos]
                    return bytes(out)
                if rc == 0:
                    _z.ZSTD_initDStream(dstream)
                if rc > 0 and inbuf.pos == inbuf.size:
                    out += dst_buf.raw[: outbuf.pos]
                    return bytes(out)
            out += dst_buf.raw[: outbuf.pos]
            cap *= 2
            if cap > (1 << 28):
                raise RuntimeError("decompressed output exceeds 256 MB")
    finally:
        _z.ZSTD_freeDStream(dstream)


def tool_names(tools):
    if not isinstance(tools, list):
        return None
    names = []
    for t in tools:
        if isinstance(t, dict):
            names.append(t.get("name"))
        elif isinstance(t, str):
            names.append(t)
    return names


def thinking_first_text(data):
    texts = data.get("texts") if isinstance(data, dict) else None
    if isinstance(texts, list):
        return "".join(str(t) for t in texts)
    return ""


def main(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = zstd_decompress_all(raw).decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]

    if "--struct" in sys.argv:
        seen = set()
        for ln in lines:
            try:
                obj = json.loads(ln)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t not in ("request/header", "reasoning-chunks") or t in seen:
                continue
            seen.add(t)
            d = obj.get("data") or {}
            if t == "request/header":
                h = d.get("header") or d
                print("HEADER keys:", sorted(h.keys()) if isinstance(h, dict) else type(h).__name__)
                cfg = h.get("config") or {} if isinstance(h, dict) else {}
                if isinstance(cfg, dict):
                    print("CONFIG keys:", sorted(cfg.keys()))
                    tools = cfg.get("tools")
                    print("tools:", type(tools).__name__, "len:", len(tools) if isinstance(tools, (list, dict)) else "?")
                    if isinstance(tools, list) and tools:
                        print("tool[0]:", json.dumps(tools[0], ensure_ascii=False)[:250])
            else:
                print("REASONING keys:", sorted(d.keys()) if isinstance(d, dict) else type(d).__name__)
                print("REASONING:", json.dumps(d, ensure_ascii=False)[:300])
        return

    print(f"== {path}  ({len(raw):,}B 压缩 / 解压后 {len(lines)} 行)")
    turn = step = None
    for ln in lines:
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError:
            continue
        typ = obj.get("type", "(none)")
        data = obj.get("data") or {}
        if typ == "turn/start":
            turn = data.get("turn")
        elif typ == "step/start":
            step = data.get("step")
        elif typ == "permission/preset":
            print(f"  [permission/preset] {json.dumps(data, ensure_ascii=False)[:160]}")
        elif typ == "sandbox/mode":
            print(f"  [sandbox/mode] {json.dumps(data, ensure_ascii=False)[:120]}")
        elif typ == "request/header":
            h = data.get("header") or data
            cfg = h.get("config") or {} if isinstance(h, dict) else {}
            names = tool_names(h.get("tools")) if isinstance(h, dict) else None
            if names is not None:
                print(f"  [request/header] turn={turn} step={step} model={cfg.get('model')} tools({len(names)}) = {names[:40]}")
            else:
                print(f"  [request/header] turn={turn} step={step} model={cfg.get('model')} tools=??? {json.dumps(h, ensure_ascii=False)[:200] if isinstance(h, dict) else h}")
        elif typ == "reasoning-chunks":
            first = " ".join(str(thinking_first_text(data)).split())[:60]
            print(f"  [thinking 开头] turn={turn} step={step}: {first!r}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
