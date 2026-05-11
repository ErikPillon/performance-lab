import os
import json
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from contextlib import asynccontextmanager
from pydantic import BaseModel, ConfigDict, model_validator
from typing import List, Dict, Any
from models import ActivityFactory
from engines.training_engine import TrainingEngine
from services import strava_client, garmin_client


ACTIVITY_TYPE_MAP = {
    "Run": "running",
    "Cycling": "cycling",
    "Swim": "swimming",
}


class ActivityModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    activity_type: str | None = None
    sub_sport: str | None = None
    timestamp: datetime | None = None
    duration_min: float | None = 0.0
    avg_heart_rate: float | int | None = 0.0
    altitude: List[float | None] | None = None
    speed: List[float | None] | None = None
    watts: List[float | None] | None = None
    distance: float | None = 0.0
    calories: float | int | None = None
    temperature: List[float | None] | None = None
    cadence: List[float | None] | None = None
    power: List[float | None] | None = None
    heart_rate: List[int | None] | None = None
    enhanced_altitude: List[float | None] | None = None
    enhanced_speed: List[float | None] | None = None
    position_lat: List[float | None] | None = None
    position_long: List[float | None] | None = None
    trimp: float | None = 0.0

    @model_validator(mode="before")
    @classmethod
    def parse_activity_type(cls, value):
        if isinstance(value, dict):
            return value

        activity_type = ACTIVITY_TYPE_MAP.get(type(value).__name__)
        if activity_type is None:
            return value

        parsed_value = {
            field_name: getattr(value, field_name, None)
            for field_name in cls.model_fields
            if field_name != "activity_type"
        }
        parsed_value["activity_type"] = activity_type
        return parsed_value


class ActivitySummaryModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    activity_type: str | None = None
    timestamp: datetime | None = None
    duration_min: float | None = 0.0
    avg_heart_rate: float | int | None = 0.0
    distance: float | None = 0.0
    trimp: float | None = 0.0


class AnalysisResult(BaseModel):
    activities: List[ActivitySummaryModel]
    metrics: List[Dict[str, Any]]


# Global cache to store the calculated results
cache = {"activities": [], "metrics": []}


def serialize_activity(activity) -> ActivityModel:
    return ActivityModel.model_validate(activity)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Calculate everything on startup and cache it
    folder_path = "../inputs"
    if os.path.exists(folder_path):
        files = [f for f in os.listdir(folder_path) if f.endswith(".fit")]
        activities_list = []
        for file in files:
            path = os.path.join(folder_path, file)
            activity_obj = ActivityFactory.create_activity(path)
            if activity_obj:
                activities_list.append(activity_obj)

        # Engine
        engine = TrainingEngine(activities_list)
        metrics_df = engine.get_training_metrics()

        # Format metrics
        metrics_records = []
        if not metrics_df.empty:
            # metrics_df has 'date' as index, so we should reset_index
            metrics_df_reset = metrics_df.reset_index()
            # Convert datetime to string
            metrics_df_reset["date"] = metrics_df_reset["date"].dt.strftime("%Y-%m-%d")
            metrics_records = metrics_df_reset.to_dict(orient="records")

        cache["activities"] = activities_list
        cache["metrics"] = metrics_records

    yield
    # Clean up on shutdown
    cache.clear()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allowing all origins for local development. Adjust in production.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/strava/authorize")
def strava_authorize():
    return RedirectResponse(strava_client.get_authorization_url())


@app.get("/api/strava/callback")
def strava_callback(code: str):
    token_data = strava_client.get_access_token(code)
    access_token = token_data["access_token"]
    activities = strava_client.get_activities(access_token)

    # Define the directory path
    data_dir = "data"
    strava_dir = os.path.join(data_dir, "strava")

    # Create the directories if they don't exist
    os.makedirs(strava_dir, exist_ok=True)

    # Save activities to a file
    file_path = os.path.join(strava_dir, "activities.json")
    with open(file_path, "w") as f:
        json.dump(activities, f, indent=4)

    return {"message": "Strava activities fetched and saved."}


@app.get("/api/garmin/fetch")
def garmin_fetch():
    activities = garmin_client.get_activities()

    # Define the directory path
    data_dir = "data"
    garmin_dir = os.path.join(data_dir, "garmin")

    # Create the directories if they don't exist
    os.makedirs(garmin_dir, exist_ok=True)

    # Save activities to a file
    file_path = os.path.join(garmin_dir, "activities.json")
    with open(file_path, "w") as f:
        json.dump(activities, f, indent=4)

    return {"message": "Garmin activities fetched and saved."}


@app.get("/api/single-activity/{file_name}", response_model=ActivityModel)
def get_single_activity(file_name: str):
    activity = next((act for act in cache["activities"] if act.name == file_name), None)
    if activity:
        return serialize_activity(activity)
    raise HTTPException(status_code=404, detail="Activity not found")


def serialize_activity_summary(activity) -> ActivitySummaryModel:
    return ActivitySummaryModel.model_validate(activity)


@app.get("/api/analysis", response_model=AnalysisResult)
def get_analysis():
    return {
        "activities": [
            serialize_activity_summary(activity) for activity in cache["activities"]
        ],
        "metrics": cache["metrics"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
