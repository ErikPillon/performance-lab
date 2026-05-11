from abc import ABC, abstractmethod
import datetime
import os
from fitparse import FitFile
import pandas as pd


# --- 1. ABSTRACT ACTIVITY CLASS ---
class Activity(ABC):
    def __init__(self, name, **kwargs):
        self.name = name
        self.sub_sport = kwargs.get("sub_sport", None)
        self.timestamp = kwargs.get("timestamp", None)
        self.duration_min = (
            kwargs.get("total_elapsed_time", 0) / 60
        )  # convert to minutes
        self.avg_heart_rate = kwargs.get("avg_heart_rate", 0)
        self.altitude: list = kwargs.get("altitude", None)
        self.speed = kwargs.get("speed", None)
        self.watts = kwargs.get("watts", None)
        self.distance = kwargs.get("total_distance", None)
        self.calories: list = kwargs.get("total_calories", None)
        self.temperature: list = kwargs.get("temperature", None)
        self.cadence: list = kwargs.get("cadence", None)
        self.power: list = kwargs.get("power", None)
        self.heart_rate: list[int] = kwargs.get("heart_rate", None)
        self.enhanced_altitude: list = kwargs.get("enhanced_altitude", None)
        self.enhanced_speed: list = kwargs.get("enhanced_speed", None)
        self.position_lat: list = kwargs.get("position_lat", None)
        self.position_long: list = kwargs.get("position_long", None)
        self.trimp = self.calculate_trimp()

    @abstractmethod
    def __dict__(self):
        return {
            "name": self.name,
            "timestamp": self.timestamp,
            "duration_min": self.duration_min,
            "avg_heart_rate": self.avg_heart_rate,
            "trimp": self.trimp,
            "watts": self.watts,
            "distance": self.distance,
            "calories": self.calories,
        }

    @abstractmethod
    def calculate_trimp(self):
        """Each sport might have a different TRIMP multiplier."""
        # Simplified base formula: Duration (min) * Intensity (HR)
        trimp_normalizer = 1
        if self.avg_heart_rate:
            trimp_normalizer = self.avg_heart_rate / 100
        return self.duration_min * trimp_normalizer


# --- 2. SPECIFIC SUBCLASSES ---
class Run(Activity):
    def calculate_trimp(self):
        # Running is more impactful, we could weight the intensity more
        return super().calculate_trimp() * 1.2


class Cycling(Activity):
    def calculate_trimp(self):
        # Here you could add logic for Watts in the future
        return super().calculate_trimp() * 1.0


class Swim(Activity):
    def calculate_trimp(self):
        # Swimming has different cardio zones
        return super().calculate_trimp() * 0.8


# --- 3. STRATEGY PATTERN (FACTORY) ---
class ActivityFactory:
    @staticmethod
    def create_activity(file_path):
        fit_file = FitFile(file_path)

        # Extract basic data from 'session' messages in the .fit file
        data = {}
        for record in fit_file.get_messages("session"):
            for data_entry in record:
                data[data_entry.name] = data_entry.value

        # Parse 'record' messages to extract time-series data
        parsed_records = ActivityFactory.parse_records(fit_file)
        df = pd.DataFrame(parsed_records)
        entities = df.columns.tolist()

        if "timestamp" in df.columns:
            df["timestamp"] = pd.to_datetime(df["timestamp"])
            df = df.set_index("timestamp")

        elevation_col = (
            "enhanced_altitude"
            if "enhanced_altitude" in df.columns
            else "altitude"
            if "altitude" in df.columns
            else None
        )

        # 3. GPS track summary
        if "position_lat" in df.columns and "position_long" in df.columns:
            # Drop NaN rows where coordinates are missing
            gps_df = df[["position_lat", "position_long"]].dropna()
            if not gps_df.empty:
                # Convert semicircles to degrees
                gps_df["lat"] = gps_df["position_lat"] * (180.0 / (2**31))
                gps_df["lon"] = gps_df["position_long"] * (180.0 / (2**31))
                # st.map(gps_df[["lat", "lon"]])

        # 4. Velocity
        speed_col = (
            "enhanced_speed"
            if "enhanced_speed" in df.columns
            else "speed"
            if "speed" in df.columns
            else None
        )
        if speed_col and not df[speed_col].dropna().empty:
            # Convert m/s to km/h for better readability
            speed_kmh = df[speed_col].dropna() * 3.6

        # Aggregate metrics
        metric_names = [e for e in entities if e != "timestamp"]
        metrics = {e: [] for e in metric_names}
        for r in parsed_records:
            for e in metric_names:
                metrics[e].append(r.get(e))

        # Add parsed metrics to data dictionary to be passed as kwargs
        data.update(metrics)

        # Retrieve key information
        file_name = os.path.basename(file_path)
        sport = data.get("sport", "generic")

        # Creation logic (Strategy)
        if sport == "running":
            return Run(file_name, **data)
        elif sport == "cycling":
            return Cycling(file_name, **data)
        elif sport == "swimming":
            return Swim(file_name, **data)
        else:
            return None

    @staticmethod
    def parse_records(fit_file) -> list[dict]:
        records = []
        for record in fit_file.get_messages("record"):
            r_dict = {}
            for data in record:
                r_dict[data.name] = data.value
            records.append(r_dict)
        return records
