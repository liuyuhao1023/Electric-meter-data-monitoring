import asyncio
import socket

def bcd_encode(val_str, length):
    val_str = val_str.zfill(length * 2)
    return bytes.fromhex(val_str)[::-1]

def make_dlt645_request(address_str, di_hex):
    addr_bytes = bcd_encode(address_str, 6)
    di_bytes = bytes.fromhex(di_hex)[::-1]
    di_plus_33 = bytes([(b + 0x33) & 0xFF for b in di_bytes])
    frame = bytearray([0x68]) + addr_bytes + bytearray([0x68, 0x11, 0x04]) + di_plus_33
    cs = sum(frame) & 0xFF
    frame.append(cs)
    frame.append(0x16)
    return bytearray([0xFE, 0xFE, 0xFE, 0xFE]) + frame

async def test():
    req = make_dlt645_request("AAAAAAAAAAAA", "00000000") # Total energy
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", 8887), timeout=2.0)
        writer.write(req)
        await writer.drain()
        print("Sent DL/T645 request...")
        
        try:
            resp = await asyncio.wait_for(reader.read(1024), timeout=2.0)
            if not resp:
                print("Received 0 bytes (Connection closed or timeout)")
            else:
                print(f"Received bytes: {resp.hex().upper()}")
        except asyncio.TimeoutError:
            print("Read timeout - no response received.")
            
        writer.close()
        await writer.wait_closed()
    except Exception as e:
        print(f"Connection failed: {e}")

asyncio.run(test())
