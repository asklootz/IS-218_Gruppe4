CREATE EXTENSION IF NOT EXISTS postgis;

-- Create user_locations table for tracking
CREATE TABLE IF NOT EXISTS public.user_locations (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  location GEOMETRY(Point, 4326) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_user_locations_user_id ON public.user_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_locations_location ON public.user_locations USING GIST(location);

-- Create safe_areas table for user-created safe zones
CREATE TABLE IF NOT EXISTS public.safe_areas (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  location GEOMETRY(Point, 4326) NOT NULL,
  capacity INT DEFAULT 0,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_safe_areas_location ON public.safe_areas USING GIST(location);
