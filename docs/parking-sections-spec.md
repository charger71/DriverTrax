# Parking Sections & Drop-off Geotagging — Implementation Spec

Context for Claude Code: this covers how DriverTrax/Backlot determines which
parking section (Backlot, PTA, Garage, etc.) a vehicle drop-off falls in,
using PostGIS on Supabase.

## 1. Enable PostGIS
```sql
create extension if not exists postgis;
```

## 2. Schema

```sql
create table parking_sections (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid references fleets(id),
  name text not null,              -- "Backlot", "PTA", "Garage"
  status text default 'open',      -- open | full | restricted
  boundary geography(Polygon, 4326) not null,
  created_at timestamptz default now()
);
create index parking_sections_boundary_idx on parking_sections using gist (boundary);

create table drop_offs (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid references vehicles(id),
  location geography(Point, 4326) not null,
  section_id uuid references parking_sections(id),  -- auto-filled, nullable
  location_name text,                                -- driver-entered fallback
  created_at timestamptz default now()
);
```

`geography` (not `geometry`) is required for correct lat/lng distance and
containment math — no manual projection needed. `4326` = standard GPS (WGS 84).

## 3. Auto-tag section on insert (trigger)

```sql
create or replace function tag_drop_off_section()
returns trigger as $$
begin
  select id into new.section_id
  from parking_sections
  where ST_Contains(boundary::geometry, new.location::geometry)
  limit 1;
  return new;
end;
$$ language plpgsql;

create trigger set_section before insert on drop_offs
for each row execute function tag_drop_off_section();
```

App only needs to insert `(vehicle_id, location)` — section_id is filled in
automatically. It comes back `null` if the point isn't inside any boundary.

## 4. "Other" location flow

When `section_id` is null after insert, the driver app should immediately
prompt: "Where is this?" and update the record:
```sql
update drop_offs set location_name = :input where id = :id;
```

Display logic (dashboard, history, etc.):
```sql
select coalesce(p.name, d.location_name, 'Unspecified') as location
from drop_offs d
left join parking_sections p on p.id = d.section_id;
```

## 5. Adding/editing section boundaries

Boundaries are authored visually in a Leaflet map tool
(`parking-sections-map.html`, manager dashboard) that exports each polygon as
either GeoJSON or a ready-to-run SQL insert using `ST_GeogFromText`:

```sql
insert into parking_sections (fleet_id, name, status, boundary)
values (
  :fleet_id,
  'Backlot',
  'open',
  ST_GeogFromText('POLYGON((-85.7590 38.2545, -85.7570 38.2545, -85.7570 38.2535, -85.7590 38.2535, -85.7590 38.2545))')
);
```
Note WKT order is `longitude latitude`, and the ring must close (first point
= last point) — the export tool handles this automatically.

## Open question / future work
Should a section that keeps getting typed as `location_name` (e.g. "Overflow
lot on 4th St") get promoted into a real `parking_sections` polygon later?
Not needed for v1, but the same map tool/export flow covers it whenever it
comes up — no new infrastructure required.
