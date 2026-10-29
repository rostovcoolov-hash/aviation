import os, time, secrets
from typing import Optional
import httpx
from fastapi import FastAPI, HTTPException, Header, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorClient

APP_DIR = os.path.dirname(os.path.abspath(__file__))
app = FastAPI(title="SkyTrack 3D", version="0.1.0")
app.mount('/static', StaticFiles(directory=os.path.join(APP_DIR, 'static')), name='static')

mongo_client = None
settings_collection = None

@app.on_event('startup')
async def startup():
    global mongo_client, settings_collection
    uri = os.getenv('MONGODB_URI')
    if uri:
        mongo_client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
        settings_collection = mongo_client[os.getenv('MONGODB_DB', 'skytrack')]['user_settings']

@app.on_event('shutdown')
async def shutdown():
    if mongo_client:
        mongo_client.close()

@app.get('/')
async def index():
    return FileResponse(os.path.join(APP_DIR, 'static', 'index.html'))

class Settings(BaseModel):
    view: str = Field(default='globe', pattern='^(globe|map)$')
    layer: str = Field(default='none', pattern='^(none|temperature|wind|precipitation|pressure|clouds|elevation)$')
    opacity: float = Field(default=0.65, ge=0, le=1)
    saturation: float = Field(default=1.35, ge=0.5, le=2.5)
    center: list[float] = Field(default=[34.8, 32.1], min_length=2, max_length=2)
    zoom: float = Field(default=4, ge=1, le=18)

@app.get('/api/config')
async def config():
    return {'weatherEnabled': bool(os.getenv('OPENWEATHER_API_KEY')), 'mongoEnabled': settings_collection is not None,
            'terrainTokenEnabled': bool(os.getenv('CESIUM_ION_TOKEN')), 'cesiumIonToken': os.getenv('CESIUM_ION_TOKEN', ''), 'flightsProvider': 'OpenSky Network',
            'weatherProvider': 'OpenWeather', 'refreshSeconds': 20}

@app.get('/api/settings')
async def get_settings(x_client_id: Optional[str] = Header(default=None)):
    if not x_client_id or len(x_client_id) > 100:
        raise HTTPException(400, 'Missing or invalid client id')
    if settings_collection is not None:
        doc = await settings_collection.find_one({'_id': x_client_id})
        if doc:
            doc.pop('_id', None)
            return doc
    return Settings().model_dump()

@app.put('/api/settings')
async def save_settings(payload: Settings, x_client_id: Optional[str] = Header(default=None)):
    if not x_client_id or len(x_client_id) > 100:
        raise HTTPException(400, 'Missing or invalid client id')
    doc = payload.model_dump()
    if settings_collection is not None:
        await settings_collection.update_one({'_id': x_client_id}, {'$set': {**doc, 'updated_at': time.time()}}, upsert=True)
    return {'ok': True, 'persisted': settings_collection is not None, 'settings': doc}

@app.get('/api/weather-tile/{layer}/{z}/{x}/{y}.png')
async def weather_tile(layer: str, z: int, x: int, y: int):
    layer_map = {'temperature':'temp_new', 'wind':'wind_new', 'precipitation':'precipitation_new', 'pressure':'pressure_new', 'clouds':'clouds_new'}
    if layer not in layer_map:
        raise HTTPException(404, 'Unknown weather layer')
    key = os.getenv('OPENWEATHER_API_KEY')
    if not key:
        raise HTTPException(503, 'Set OPENWEATHER_API_KEY in Render environment variables')
    url = f'https://tile.openweathermap.org/map/{layer_map[layer]}/{z}/{x}/{y}.png?appid={key}'
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(url)
    if response.status_code != 200:
        raise HTTPException(response.status_code, 'OpenWeather tile request failed; check key, plan and quota')
    from fastapi.responses import Response
    return Response(content=response.content, media_type='image/png', headers={'Cache-Control':'public, max-age=300'})

@app.get('/api/flights')
async def flights(lamin: float = Query(-85, ge=-90, le=90), lomin: float = Query(-180, ge=-180, le=180),
                  lamax: float = Query(85, ge=-90, le=90), lomax: float = Query(180, ge=-180, le=180)):
    if lamax <= lamin or lomax <= lomin:
        raise HTTPException(400, 'Invalid bounding box')
    params = {'lamin':lamin, 'lomin':lomin, 'lamax':lamax, 'lomax':lomax}
    headers = {}
    client_id, client_secret = os.getenv('OPENSKY_CLIENT_ID'), os.getenv('OPENSKY_CLIENT_SECRET')
    if client_id and client_secret:
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                token_resp = await client.post('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
                    data={'grant_type':'client_credentials','client_id':client_id,'client_secret':client_secret})
                token_resp.raise_for_status()
                headers['Authorization'] = 'Bearer ' + token_resp.json()['access_token']
        except Exception:
            raise HTTPException(502, 'OpenSky authentication failed')
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get('https://opensky-network.org/api/states/all', params=params, headers=headers)
        if response.status_code == 429:
            raise HTTPException(429, 'OpenSky rate limit reached; wait before retrying')
        response.raise_for_status()
        payload = response.json()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, 'OpenSky is temporarily unavailable')
    result = []
    # OpenSky state vector: 0 ICAO, 1 callsign, 2 country, 5 lon, 6 lat, 7 baro altitude m,
    # 8 on-ground, 9 velocity m/s, 10 heading deg, 11 vertical rate m/s, 13 geo altitude m
    for s in (payload.get('states') or []):
        if len(s) < 11 or s[5] is None or s[6] is None:
            continue
        result.append({'icao24':s[0], 'callsign':(s[1] or '').strip(), 'country':s[2], 'lon':s[5], 'lat':s[6],
            'altitude':s[7], 'onGround':s[8], 'velocity':s[9], 'heading':s[10], 'verticalRate':s[11] if len(s)>11 else None,
            'geoAltitude':s[13] if len(s)>13 else None})
    return {'time':payload.get('time'), 'count':len(result), 'states':result, 'source':'OpenSky Network ADS-B', 'commercialSchedulesIncluded':False}
