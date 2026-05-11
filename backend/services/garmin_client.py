import os
from dotenv import load_dotenv

# Load garmin specific environment variables
load_dotenv(dotenv_path=".env.garmin")

GARMIN_EMAIL = os.getenv("GARMIN_EMAIL")
GARMIN_PASSWORD = os.getenv("GARMIN_PASSWORD")

def get_activities():
    # Placeholder for Garmin Connect integration
    # The actual implementation will depend on the authentication method
    # and the Garmin Connect API (or library used)
    print(f"Fetching activities for {GARMIN_EMAIL}...")
    return []
