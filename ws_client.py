import asyncio
import websockets

async def main():
    uri = 'ws://127.0.0.1:8080/ws/app'
    try:
        async with websockets.connect(uri) as ws:
            print('connected')
            msg = await ws.recv()
            print('recv:', msg)
    except Exception as e:
        print('error', e)

if __name__ == '__main__':
    asyncio.run(main())
