-- ============================================================
-- DriverTrax — 2-week random seed keyed to real profiles.
--
-- Generated 2026-07-08 for demo/presentation purposes.
-- Populates today + 13 days ahead with realistic driver,
-- detailer, announcement, and staffing-request activity for
-- every profile EXCEPT charger71@gmail.com.
--
-- Volumes (matching real ops):
--   • Drivers: 9-hour shift, 30-45 vehicles/shift,
--     per-vehicle time = drive-time for destination + turnaround.
--       QTA      5-10 min
--       BACKLOT  10-13 min
--       ATLANTIC 13-17 min
--       GARAGE   2-4 min
--       BRANCH / OTHER   8-20 min
--   • Detailers: 35-45 vehicles/shift.
--       QUICK_FLIP / FUEL   15-25 min
--       REGULAR / SPIFFY / PET_HAIR / PRIORITY / DETAIL   25-35 min
--   • Managers/CXR/admins: 5-15 driver records each so they
--     appear on the driver leaderboards.
--   • CXR/managers post 12 announcements + 6 extra-driver
--     requests across the window.
--
-- Tagging for tear-down:
--   • Records use id range 1900000000001..1900000099999.
--   • Announcements + extra_driver_requests get "[seed2wk]" in
--     their body/note text.
--
-- Safe to re-run — the tear-down block at the top clears
-- prior seed rows before re-inserting.
-- ============================================================

-- ============================================================
-- TEAR DOWN previous seed (safe if none exists)
-- ============================================================
DELETE FROM detail_jobs           WHERE record_id LIKE '1900%';
DELETE FROM records               WHERE id LIKE '1900%';
DELETE FROM announcements         WHERE body LIKE '%[seed2wk]%';
DELETE FROM extra_driver_requests WHERE note LIKE '%[seed2wk]%';

-- ============================================================
-- SEED
-- ============================================================
DO $$
DECLARE
  -- --------- Real user UUIDs (charger71 excluded) ----------
  admin_don       uuid := 'bf531678-fcad-4b02-be26-28269ae95219';  -- Don          (admin)
  admin_henry     uuid := '7a477e6d-a974-4667-b87b-083fa615e876';  -- Henry H.     (admin)
  cxr_david       uuid := '1ecc254d-3e0f-432f-bb29-0f223647f220';  -- David X.     (cxr)
  detailer_jeff   uuid := 'f90155ab-7c5e-4199-8def-b072319b9e92';  -- Jeff X.      (detailer)
  detailer_nicole uuid := 'c84135de-df29-48ff-bdea-ef44d9fecdf0';  -- Nicole X.    (detailer)
  driver_bob      uuid := 'd72be3a0-03c3-4f0e-b9bb-8fd28ee2d48d';  -- Bob Barker   (driver)
  driver_larry    uuid := 'a79fd8b4-d10d-4993-b44a-1d5b0c17cbd0';  -- Larry X.     (driver)
  mgr_blake       uuid := '210dd8e7-2681-4f93-ad67-ae6a746b59a8';  -- Blake C.     (manager)
  mgr_bryan       uuid := 'a6886dd2-9e69-4fbc-91b8-4856c7708dae';  -- Bryan        (manager)
  mgr_don_h       uuid := '866eb85a-5633-4d2f-b9b8-72907bee8ac7';  -- Don.H        (manager)

  drivers_full    uuid[];
  drivers_light   uuid[];
  detailers       uuid[];

  vins text[] := ARRAY[
    '1HGCM82633A123456','5YJ3E1EA7KF317001','1FTFW1ET5DFC10312','JTDKARFU6J3057891',
    'WBA8E9G50GNT12345','KMHD84LF5JU654321','3VWFE21C04M000123','1N4AL3AP4JC123987',
    '2HGFC2F59KH567890','1C4PJMCB5KD234567','5NPE34AF6JH012345','1G1ZD5ST7JF234567',
    '4T1B11HK5JU098765','3FA6P0H75JR123456','1FA6P8TH6J5123456','WAUFFAFL5DA123456',
    'SAJWA1C73D8V12345','WDDGF8AB1DR123456','5J6RM4H73GL012345','1GNKVGED2BJ123456',
    'KNDJP3A53G7123456','JN8AS5MT7AW123456','1FMCU0F76EUA12345','5XYKT3A66CG123456',
    '2C4RC1BG5HR123456','WP0AB2A91DS123456','JM3KE2CY5E0123456','1G1JC5SH5C4123456',
    '5FNRL5H62JB012345','19XFC2F50GE123456','1FATP8UH7J5123456','3GNAXUEV0JL123456',
    'KNDPM3AC8H7123456','1FT7W2BT5DEA12345','JTHBE1BL2EA123456','1G6DC5EY1B0123456',
    '5UXKR0C58H0123456','WBAVA37527NM12345','1C6RR7LT9GS123456','3N1AB7AP5GY123456',
    '2T1BURHE0GC123456','1HGCV1F30JA123456','5NPD84LF8HH123456','1FM5K8D85HGA12345',
    'KMHC65LE7HU123456','JN1AZ4EH7AM123456','1GCRKSE74CZ123456','WAUDF78E68A123456',
    'JM1NDAB75G0123456','1G1ZE5ST8HF123456','5FNYF6H59GB123456','1FTEX1CM2EFA12345'
  ];

  -- Weighted status pool (CLEAN heaviest, matches real distribution).
  statuses text[] := ARRAY[
    'CLEAN','CLEAN','CLEAN','CLEAN','CLEAN','CLEAN','CLEAN',
    'DIRTY','DIRTY','DIRTY','REWASH','REWASH','BODY',
    'PM','MK','MR','OM','AUDIT FAIL','GLASS','TI'
  ];

  destinations text[] := ARRAY[
    'GARAGE','QTA','QTA','QTA','QTA','BACKLOT','BACKLOT','ATLANTIC','BRANCH','OTHER'
  ];

  notes_pool text[] := ARRAY[
    '','','','','','','',                            -- empty is the norm
    'Lot 3 row 12','Low fuel','Tire pressure light',
    'Pulled for inspection','Ready for pickup',
    'Left front tire slightly low','Handed off to PM team',
    'Interior needs vacuum','Returned with light damage',
    'Customer left phone charger','EV charge at 22%',
    'Wash bay queue','Heavy rain'
  ];

  quick_todo jsonb := '[
    {"id":"TRASH","label":"Trash","done":true,"note":"","done_at":null},
    {"id":"VACUUM","label":"Vacuum","done":true,"note":"","done_at":null},
    {"id":"DISINFECT","label":"Disinfect","done":true,"note":"","done_at":null},
    {"id":"DEODORIZE","label":"Deodorize","done":true,"note":"","done_at":null},
    {"id":"WINDOWS","label":"Windows","done":true,"note":"","done_at":null},
    {"id":"RESET_RADIO","label":"Reset Radio","done":true,"note":"","done_at":null}
  ]'::jsonb;

  full_todo jsonb := '[
    {"id":"TRASH","label":"Trash","done":true,"note":"","done_at":null},
    {"id":"VACUUM","label":"Vacuum","done":true,"note":"","done_at":null},
    {"id":"DISINFECT","label":"Disinfect","done":true,"note":"","done_at":null},
    {"id":"DEODORIZE","label":"Deodorize","done":true,"note":"","done_at":null},
    {"id":"WINDOWS","label":"Windows","done":true,"note":"","done_at":null},
    {"id":"RESET_RADIO","label":"Reset Radio","done":true,"note":"","done_at":null},
    {"id":"SCRUB","label":"Scrub","done":true,"note":"","done_at":null},
    {"id":"WASH","label":"Wash","done":true,"note":"","done_at":null},
    {"id":"CHECK_FLUIDS","label":"Check Air and Washer Fluids","done":true,"note":"","done_at":null}
  ]'::jsonb;

  -- Iteration state
  rec_counter       bigint := 1900000000000;
  day_idx           int;
  usr               uuid;
  shift_num         int;
  shift_start       timestamptz;
  cursor_ts         timestamptz;
  vehicles_in_shift int;
  v                 int;
  vin               text;
  status_pick       text;
  dest_pick         text;
  note_pick         text;
  drive_min         int;
  lat               numeric;
  lng               numeric;
  damage_json       jsonb;
  tires_json        jsonb;
  cond_pick         int;
  conds             text[];
  todo              jsonb;
  job_time_min      int;
  in_progress       boolean;
  base_date         date;
BEGIN
  drivers_full  := ARRAY[driver_bob, driver_larry];
  drivers_light := ARRAY[cxr_david, mgr_blake, mgr_bryan, mgr_don_h, admin_don, admin_henry];
  detailers     := ARRAY[detailer_jeff, detailer_nicole];

  base_date := current_date;

  -- ==========================================================
  -- DRIVERS (full-time) — 14 days × 2 drivers × 30-45 vehicles
  -- ==========================================================
  FOR day_idx IN 0..13 LOOP
    FOREACH usr IN ARRAY drivers_full LOOP
      shift_num   := 1 + ((day_idx + array_position(drivers_full, usr)) % 3);
      shift_start := (base_date + day_idx)::timestamptz
                   + CASE shift_num
                       WHEN 1 THEN interval '6 hours'
                       WHEN 2 THEN interval '10 hours'
                       ELSE        interval '14 hours'
                     END;
      vehicles_in_shift := 30 + floor(random() * 16)::int;    -- 30..45
      cursor_ts := shift_start;

      FOR v IN 1..vehicles_in_shift LOOP
        vin         := vins[1 + floor(random() * array_length(vins, 1))::int];
        status_pick := statuses[1 + floor(random() * array_length(statuses, 1))::int];
        dest_pick   := destinations[1 + floor(random() * array_length(destinations, 1))::int];
        note_pick   := notes_pool[1 + floor(random() * array_length(notes_pool, 1))::int];

        drive_min := CASE dest_pick
          WHEN 'QTA'      THEN 5  + floor(random() *  6)::int   -- 5..10
          WHEN 'BACKLOT'  THEN 10 + floor(random() *  4)::int   -- 10..13
          WHEN 'ATLANTIC' THEN 13 + floor(random() *  5)::int   -- 13..17
          WHEN 'GARAGE'   THEN 2  + floor(random() *  3)::int   -- 2..4
          ELSE                 8  + floor(random() * 13)::int   -- 8..20
        END + 2 + floor(random() * 3)::int;                     -- + turnaround
        cursor_ts := cursor_ts + (drive_min || ' minutes')::interval;

        lat := 38.1740 + (random() * 0.005 - 0.0025);
        lng := -85.7360 + (random() * 0.005 - 0.0025);

        -- ~15% chance of damage marks, ~10% chance of tire issues.
        damage_json := CASE
          WHEN random() < 0.15 THEN jsonb_build_array(
            jsonb_build_object(
              'panel', (ARRAY['FRONT_BUMPERS','REAR_BUMPER','NEAR_SIDE_DOOR','OFF_SIDE_DOOR','FRONT_BONNET'])
                       [1 + floor(random() * 5)::int],
              'type',  (ARRAY['dent','scratch','chip','crack'])[1 + floor(random() * 4)::int]
            )
          )
          ELSE '[]'::jsonb
        END;
        tires_json := CASE
          WHEN random() < 0.10 THEN jsonb_build_object(
            (ARRAY['FL','FR','RL','RR'])[1 + floor(random() * 4)::int],
            jsonb_build_object(
              'condition', (ARRAY['worn','low','flat','replace'])[1 + floor(random() * 4)::int],
              'psi',       20 + floor(random() * 15)::int
            )
          )
          ELSE '{}'::jsonb
        END;

        rec_counter := rec_counter + 1;
        INSERT INTO records (
          id, user_id, serial_id, status, destination,
          no_tag, shuttle, transport,
          shift_num, notes, lat, lng, gps_error,
          damage_marks, tire_details, ts
        ) VALUES (
          rec_counter::text, usr, vin, status_pick, dest_pick,
          random() < 0.05, random() < 0.08, random() < 0.05,
          shift_num, note_pick, lat, lng, false,
          damage_json, tires_json, cursor_ts
        );
      END LOOP;
    END LOOP;
  END LOOP;

  -- ==========================================================
  -- LIGHT DRIVERS (managers / CXR / admins covering the floor)
  -- 5-15 records each spread randomly across the 14 days.
  -- ==========================================================
  FOREACH usr IN ARRAY drivers_light LOOP
    vehicles_in_shift := 5 + floor(random() * 11)::int;   -- 5..15
    FOR v IN 1..vehicles_in_shift LOOP
      day_idx   := floor(random() * 14)::int;
      shift_num := 1 + floor(random() * 3)::int;
      shift_start := (base_date + day_idx)::timestamptz
                   + CASE shift_num
                       WHEN 1 THEN interval '6 hours'
                       WHEN 2 THEN interval '10 hours'
                       ELSE        interval '14 hours'
                     END;
      cursor_ts := shift_start + (floor(random() * 480)::text || ' minutes')::interval;

      vin         := vins[1 + floor(random() * array_length(vins, 1))::int];
      status_pick := statuses[1 + floor(random() * array_length(statuses, 1))::int];
      dest_pick   := destinations[1 + floor(random() * array_length(destinations, 1))::int];
      note_pick   := notes_pool[1 + floor(random() * array_length(notes_pool, 1))::int];
      lat := 38.1740 + (random() * 0.005 - 0.0025);
      lng := -85.7360 + (random() * 0.005 - 0.0025);

      rec_counter := rec_counter + 1;
      INSERT INTO records (
        id, user_id, serial_id, status, destination,
        no_tag, shuttle, transport,
        shift_num, notes, lat, lng, gps_error, ts
      ) VALUES (
        rec_counter::text, usr, vin, status_pick, dest_pick,
        false, false, false,
        shift_num, note_pick, lat, lng, false, cursor_ts
      );
    END LOOP;
  END LOOP;

  -- ==========================================================
  -- DETAILERS — 14 days × 2 detailers × 35-45 vehicles.
  -- Every job writes both a records row (status DETAILED, occasional
  -- DETAILING when the shift ends mid-job) and a matching detail_jobs row.
  -- ==========================================================
  FOR day_idx IN 0..13 LOOP
    FOREACH usr IN ARRAY detailers LOOP
      shift_num   := 1 + ((day_idx + array_position(detailers, usr)) % 3);
      shift_start := (base_date + day_idx)::timestamptz
                   + CASE shift_num
                       WHEN 1 THEN interval '6 hours'
                       WHEN 2 THEN interval '10 hours'
                       ELSE        interval '14 hours'
                     END;
      vehicles_in_shift := 35 + floor(random() * 11)::int;    -- 35..45
      cursor_ts := shift_start;

      FOR v IN 1..vehicles_in_shift LOOP
        vin       := vins[1 + floor(random() * array_length(vins, 1))::int];
        note_pick := notes_pool[1 + floor(random() * array_length(notes_pool, 1))::int];
        cond_pick := floor(random() * 7)::int;   -- 0..6

        conds := CASE cond_pick
          WHEN 0 THEN ARRAY['QUICK_FLIP']
          WHEN 1 THEN ARRAY['REGULAR']
          WHEN 2 THEN ARRAY['SPIFFY','REGULAR']
          WHEN 3 THEN ARRAY['PET_HAIR','REGULAR']
          WHEN 4 THEN ARRAY['FUEL','QUICK_FLIP']
          WHEN 5 THEN ARRAY['PRIORITY','REGULAR']
          ELSE        ARRAY['DETAIL']
        END;

        todo := CASE
          WHEN cond_pick IN (0, 4) THEN quick_todo   -- QUICK_FLIP + FUEL
          ELSE                          full_todo
        END;

        IF cond_pick IN (0, 4) THEN
          job_time_min := 15 + floor(random() * 11)::int;    -- 15..25
        ELSE
          job_time_min := 25 + floor(random() * 11)::int;    -- 25..35
        END IF;
        cursor_ts := cursor_ts + (job_time_min || ' minutes')::interval;

        lat := 38.1745 + (random() * 0.003 - 0.0015);
        lng := -85.7355 + (random() * 0.003 - 0.0015);

        -- Last vehicle sometimes stays in-progress at shift end.
        in_progress := (v = vehicles_in_shift AND random() < 0.35);

        rec_counter := rec_counter + 1;

        INSERT INTO records (
          id, user_id, serial_id, status,
          no_tag, shuttle, transport,
          notes, lat, lng, gps_error, ts, conditions
        ) VALUES (
          rec_counter::text, usr, vin,
          CASE WHEN in_progress THEN 'DETAILING' ELSE 'DETAILED' END,
          false, false, false, note_pick, lat, lng, false, cursor_ts, conds
        );

        INSERT INTO detail_jobs (
          id, detailer_id, serial_id, record_id,
          condition_tags, todo_state,
          started_at, completed_at, completion_lat, completion_lng
        ) VALUES (
          gen_random_uuid(), usr, vin, rec_counter::text,
          conds, todo,
          cursor_ts - (job_time_min || ' minutes')::interval,
          CASE WHEN in_progress THEN NULL ELSE cursor_ts END,
          CASE WHEN in_progress THEN NULL ELSE lat       END,
          CASE WHEN in_progress THEN NULL ELSE lng       END
        );
      END LOOP;
    END LOOP;
  END LOOP;

  -- ==========================================================
  -- ANNOUNCEMENTS (12 posts, tagged [seed2wk] for tear-down)
  -- ==========================================================
  INSERT INTO announcements (author_id, body, status, created_at) VALUES
    (cxr_david, '[seed2wk] Welcome to the week — please check tire pressures before pulling cars off the lot.',
                                                                                            'open', base_date::timestamptz         + interval '7 hours'),
    (mgr_blake, '[seed2wk] Reminder: park all EVs in rows 8-10 only. Chargers are reserved for fleet vehicles.',
                                                                                            'open', (base_date + 1)::timestamptz  + interval '8 hours'),
    (mgr_bryan, '[seed2wk] Body shop pickup at 2pm today. Avoid lane 4 between 1:30 and 2:30.',
                                                                                            'open', (base_date + 2)::timestamptz  + interval '13 hours'),
    (cxr_david, '[seed2wk] Heavy returns expected this afternoon — please prioritize CLEAN and READY status.',
                                                                                            'open', (base_date + 3)::timestamptz  + interval '11 hours'),
    (mgr_don_h, '[seed2wk] New detailer onboarding tomorrow morning. Show them the wash bay rotation.',
                                                                                            'open', (base_date + 4)::timestamptz  + interval '10 hours'),
    (mgr_blake, '[seed2wk] Storm watch: secure all cones and move loose items into the shed before 5pm.',
                                                                                            'open', (base_date + 5)::timestamptz  + interval '15 hours'),
    (cxr_david, '[seed2wk] PM team needs all MK vehicles tagged with the yellow slip — no exceptions.',
                                                                                            'open', (base_date + 6)::timestamptz  + interval '9 hours'),
    (mgr_bryan, '[seed2wk] Weekend prep: extra hands on the QTA line Saturday morning.',
                                                                                            'open', (base_date + 7)::timestamptz  + interval '12 hours'),
    (cxr_david, '[seed2wk] Lost & found: black hoodie turned in from a Corolla returned this morning.',
                                                                                            'open', (base_date + 8)::timestamptz  + interval '11 hours'),
    (mgr_don_h, '[seed2wk] Reminder — no personal vehicles in the QTA queue at any time.',
                                                                                            'open', (base_date + 10)::timestamptz + interval '9 hours'),
    (mgr_blake, '[seed2wk] Coffee in the breakroom — courtesy of management. Enjoy the shift.',
                                                                                            'open', (base_date + 11)::timestamptz + interval '7 hours'),
    (cxr_david, '[seed2wk] End-of-week audit at 3pm Friday. Please have all MR cars staged in front row.',
                                                                                            'open', (base_date + 12)::timestamptz + interval '10 hours');

  -- ==========================================================
  -- EXTRA DRIVER REQUESTS (6, tagged [seed2wk])
  -- ==========================================================
  INSERT INTO extra_driver_requests (manager_id, shift_time, needed_count, shifts, note, status) VALUES
    (cxr_david, (base_date + 1)::timestamptz,  3, ARRAY['AM']::text[],        '[seed2wk] Heavy return day expected', 'open'),
    (mgr_blake, (base_date + 2)::timestamptz,  2, ARRAY['PM']::text[],        '[seed2wk] PM shuttle coverage',       'open'),
    (mgr_bryan, (base_date + 3)::timestamptz,  4, ARRAY['AM','MID']::text[],  '[seed2wk] Weekend prep',              'open'),
    (mgr_don_h, (base_date + 7)::timestamptz,  2, ARRAY['MID']::text[],       '[seed2wk] Mid-shift gap',             'open'),
    (cxr_david, (base_date + 9)::timestamptz,  3, ARRAY['AM']::text[],        '[seed2wk] Back-to-back Monday',       'open'),
    (mgr_blake, (base_date + 12)::timestamptz, 1, ARRAY['PM']::text[],        '[seed2wk] Friday audit backup',       'open');

  RAISE NOTICE 'Seed complete. Total records inserted: %', rec_counter - 1900000000000;
END $$;

-- ============================================================
-- TEAR DOWN standalone (re-run this block only to wipe the seed)
-- ============================================================
-- DELETE FROM detail_jobs           WHERE record_id LIKE '1900%';
-- DELETE FROM records               WHERE id LIKE '1900%';
-- DELETE FROM announcements         WHERE body LIKE '%[seed2wk]%';
-- DELETE FROM extra_driver_requests WHERE note LIKE '%[seed2wk]%';
