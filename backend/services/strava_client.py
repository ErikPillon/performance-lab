import os
import requests
from dotenv import load_dotenv

load_dotenv()

STRAVA_CLIENT_ID = os.getenv("STRAVA_CLIENT_ID")
STRAVA_CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET")
STRAVA_API_URL = "https://www.strava.com/api/v3"
REDIRECT_URI = "http://localhost:8000/api/strava/callback"


def get_authorization_url():
    params = {
        "client_id": STRAVA_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "read,activity:read_all",
    }
    return f"https://www.strava.com/oauth/authorize?{'&'.join([f'{k}={v}' for k, v in params.items()])}"


def get_access_token(code: str):
    data = {
        "client_id": STRAVA_CLIENT_ID,
        "client_secret": STRAVA_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
    }
    response = requests.post("https://www.strava.com/oauth/token", data=data)
    response.raise_for_status()
    return response.json()


def get_activities(access_token: str):
    headers = {"Authorization": f"Bearer {access_token}"}
    response = requests.get(f"{STRAVA_API_URL}/athlete/activities", headers=headers)
    response.raise_for_status()
    return response.json()
