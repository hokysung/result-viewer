"""Read one string attribute of an HDF5 file's root group, with the standard library only.

phys-analysis ``session_viewer`` writes the export's description as the JSON
root attribute ``meta`` of ``session.h5`` (``meta["streams"]`` names each
stream's sorting).  The viewer only needs that one string, so instead of h5py
this walks the few structures that lead to it: the superblock (versions 0-3),
the root group's object header (versions 1 and 2, with continuation blocks),
its attribute messages (versions 1-3), and for a variable-length string the
global heap object it points to.  Attributes kept in dense storage (a fractal
heap, used for groups with many or very large attributes) are not read:
``root_attribute`` returns None for them, as for anything it cannot follow.
"""
from __future__ import annotations

import json
import struct

SIGNATURE = b"\x89HDF\r\n\x1a\n"
MSG_ATTRIBUTE = 0x000C
MSG_CONTINUATION = 0x0010
MAX_READ = 1 << 20          # no single structure the reader follows is larger
MAX_MESSAGES = 4096
MAX_BLOCKS = 64


class _Unreadable(Exception):
    pass


class _File:
    def __init__(self, handle):
        self.h = handle
        self.offsets = 8
        self.lengths = 8
        self.base = 0

    def read(self, addr, n):
        if n < 0 or n > MAX_READ:
            raise _Unreadable("size out of range")
        self.h.seek(addr)
        data = self.h.read(n)
        if len(data) != n:
            raise _Unreadable("short read")
        return data

    def uint(self, data, pos, size):
        if pos + size > len(data):
            raise _Unreadable("truncated")
        return int.from_bytes(data[pos:pos + size], "little")


def _pad8(n):
    return (n + 7) & ~7


def _root_header(f):
    head = f.read(0, 48)
    if head[:8] != SIGNATURE:
        raise _Unreadable("not HDF5")
    version = head[8]
    if version in (0, 1):
        f.offsets, f.lengths = head[13], head[14]
        pos = 24 + (4 if version == 1 else 0)
        block = f.read(0, pos + 4 * f.offsets + 2 * f.offsets + 8)
        f.base = f.uint(block, pos, f.offsets)
        entry = pos + 4 * f.offsets
        return f.base + f.uint(block, entry + f.offsets, f.offsets)  # link name offset, then object header address
    if version in (2, 3):
        f.offsets, f.lengths = head[9], head[10]
        block = f.read(0, 12 + 4 * f.offsets)
        f.base = f.uint(block, 12, f.offsets)
        return f.base + f.uint(block, 12 + 3 * f.offsets, f.offsets)
    raise _Unreadable(f"superblock version {version}")


def _messages(f, addr):
    """``(type, data)`` for every message of the object header at ``addr``, continuation blocks included."""
    first = f.read(addr, 16)
    out = []
    pending = []
    if first[:4] == b"OHDR":
        version, flags = first[4], first[5]
        pos = 6 + (16 if flags & 0x20 else 0) + (4 if flags & 0x10 else 0)
        width = 1 << (flags & 0x03)
        head = f.read(addr, pos + width)
        size = f.uint(head, pos, width)
        body = f.read(addr + pos + width, size)
        pending.append(("v2", body, flags))
    elif first[0] == 1:
        size = f.uint(first, 8, 4)
        pending.append(("v1", f.read(addr + 16, size), 0))
    else:
        raise _Unreadable("object header version")
    blocks = 0
    while pending:
        blocks += 1
        if blocks > MAX_BLOCKS:
            raise _Unreadable("too many continuation blocks")
        kind, body, flags = pending.pop(0)
        pos = 0
        while True:
            if kind == "v1":
                if pos + 8 > len(body):
                    break
                mtype, msize = f.uint(body, pos, 2), f.uint(body, pos + 2, 2)
                start = pos + 8
                pos = start + msize
            else:
                start = pos + 4 + (2 if flags & 0x04 else 0)
                if start > len(body):  # what is left is the gap before the checksum
                    break
                mtype, msize = body[pos], f.uint(body, pos + 1, 2)
                pos = start + msize
                if pos > len(body):
                    break
            data = body[start:start + msize]
            if mtype == MSG_CONTINUATION:
                where, length = f.uint(data, 0, f.offsets), f.uint(data, f.offsets, f.lengths)
                block = f.read(f.base + where, length)
                if block[:4] == b"OCHK":
                    pending.append(("v2", block[4:-4], flags))
                else:
                    pending.append(("v1", block, 0))
            else:
                out.append((mtype, data))
            if len(out) > MAX_MESSAGES:
                raise _Unreadable("too many messages")
    return out


def _attribute(f, data):
    """``(name, value)`` of one attribute message when its value is a string, else ``(name, None)``."""
    version = data[0]
    name_size, type_size, space_size = (f.uint(data, 2 + 2 * i, 2) for i in range(3))
    if version == 1:
        pos = 8
        name = data[pos:pos + name_size]
        pos += _pad8(name_size)
        dtype = data[pos:pos + type_size]
        pos += _pad8(type_size) + _pad8(space_size)
    elif version in (2, 3):
        pos = 8 + (1 if version == 3 else 0)
        name = data[pos:pos + name_size]
        pos += name_size
        dtype = data[pos:pos + type_size]
        pos += type_size + space_size
    else:
        raise _Unreadable("attribute version")
    name = name.rstrip(b"\0").decode("utf-8", "replace")
    value = data[pos:]
    if len(dtype) < 8:
        return name, None
    cls = dtype[0] & 0x0F
    if cls == 3:  # fixed-length string
        return name, value[:f.uint(dtype, 4, 4)].split(b"\0", 1)[0].decode("utf-8", "replace")
    if cls == 9 and dtype[1] & 0x0F == 1:  # variable-length string: length, global heap collection, object index
        length = f.uint(value, 0, 4)
        collection = f.uint(value, 4, f.offsets)
        index = f.uint(value, 4 + f.offsets, 4)
        return name, _heap_object(f, collection, index, length).decode("utf-8", "replace")
    return name, None


def _heap_object(f, collection, index, length):
    head = f.read(f.base + collection, 8 + f.lengths)
    if head[:4] != b"GCOL":
        raise _Unreadable("not a global heap collection")
    size = f.uint(head, 8, f.lengths)
    heap = f.read(f.base + collection, size) if size <= MAX_READ else None
    if heap is None:
        raise _Unreadable("global heap too large")
    pos = 8 + f.lengths
    while pos + 8 + f.lengths <= len(heap):
        obj, osize = f.uint(heap, pos, 2), f.uint(heap, pos + 8, f.lengths)
        if obj == 0:
            break
        start = pos + 8 + f.lengths
        if obj == index:
            return heap[start:start + min(osize, length)]
        pos = start + _pad8(osize)
    raise _Unreadable("global heap object not found")


def root_attribute(path, name):
    """The string attribute ``name`` of ``path``'s root group, or None when there is none or it cannot be read."""
    try:
        with open(path, "rb") as handle:
            f = _File(handle)
            for mtype, data in _messages(f, _root_header(f)):
                if mtype == MSG_ATTRIBUTE:
                    found, value = _attribute(f, data)
                    if found == name:
                        return value
    except (OSError, _Unreadable, IndexError, ValueError, struct.error):
        return None
    return None


def session_meta(path):
    """``session.h5``'s ``meta`` attribute as a dict, or None."""
    text = root_attribute(path, "meta")
    if not text:
        return None
    try:
        meta = json.loads(text)
    except ValueError:
        return None
    return meta if isinstance(meta, dict) else None
