import socket

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(5.0)
try:
    print('Connecting...')
    s.connect(('127.0.0.1', 8887))
    req = bytes([0xFE, 0xFE, 0xFE, 0xFE, 0x68, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0x68, 0x11, 0x04, 0x33, 0x33, 0x34, 0x33, 0xAD, 0x16])
    s.send(req)
    print('Sent')
    print(s.recv(1024).hex())
except Exception as e:
    print('Error:', e)
finally:
    s.close()
