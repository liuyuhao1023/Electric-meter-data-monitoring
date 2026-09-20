import asyncio
import websockets
import json

async def test():
    uri = "ws://localhost:3004/ws"
    async with websockets.connect(uri) as ws:
        msg = await ws.recv()
        print(json.dumps(json.loads(msg), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    asyncio.run(test())
