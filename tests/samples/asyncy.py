import asyncio

import httpx


async def fetch_user(user_id: int):
    async with httpx.AsyncClient() as client:
        response = await client.get("https://api.example.com/users/%d" % user_id)
        await asyncio.sleep(0)
        body = response.json()
    return body["name"]


async def agen(n: int):
    for i in range(n):
        yield i + 1
