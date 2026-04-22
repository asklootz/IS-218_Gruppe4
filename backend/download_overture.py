#!/usr/bin/env python3
"""
Download Overture Maps place data for Agder region
BBOX for Agder: 7.0 (west), 57.8 (south), 9.5 (east), 59.0 (north)
"""
import subprocess
import json
import sys
import os

AGDER_BBOX = "7.0,57.8,9.5,59.0"
OUTPUT_FILE = "/app/places_agder.geojson"

def download_overture_data():
    """Download Overture places data for Agder"""
    try:
        print("Downloading Overture Maps place data for Agder...")
        cmd = [
            "overturemaps",
            "download",
            f"--bbox={AGDER_BBOX}",
            "-f", "geojson",
            "--type=place",
            "-o", OUTPUT_FILE
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        
        if result.returncode != 0:
            print(f"Error downloading: {result.stderr}", file=sys.stderr)
            return False
        
        if os.path.exists(OUTPUT_FILE):
            print(f"✓ Successfully downloaded Overture data to {OUTPUT_FILE}")
            with open(OUTPUT_FILE, 'r') as f:
                data = json.load(f)
                feature_count = len(data.get('features', []))
                print(f"✓ Downloaded {feature_count} place features")
            return True
        else:
            print("Error: Output file not created", file=sys.stderr)
            return False
            
    except subprocess.TimeoutExpired:
        print("Error: Download timed out", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    success = download_overture_data()
    sys.exit(0 if success else 1)
