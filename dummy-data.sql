-- ============================================================
-- DriverTrax dummy seed data
-- Three accounts: driver, cxr, detailer
-- Multi-day history (~100+ records per active role)
-- ============================================================
--
-- SETUP (do this first):
--   1) In Supabase Auth, create three accounts:
--        driver-test@drivertrax.test
--        cxr-test@drivertrax.test
--        detailer-test@drivertrax.test
--   2) Grab each user's UUID from auth.users.
--   3) Replace the three UUIDs in the block below.
--   4) Paste the whole file into the Supabase SQL editor and run.
--
-- This script is idempotent for profiles (uses upsert). Records,
-- detail_jobs, announcements and extra_driver_requests are inserted
-- fresh each run — re-running will duplicate them. To re-seed,
-- DELETE the rows first (see bottom of file for a tear-down block).
-- ============================================================

-- ============================================================
-- REPLACE THESE THREE UUIDs WITH YOUR REAL auth.users IDs
-- ============================================================
DO $$
DECLARE
  driver_id    uuid := '11111111-1111-1111-1111-111111111111';
  cxr_id       uuid := '22222222-2222-2222-2222-222222222222';
  detailer_id  uuid := '33333333-3333-3333-3333-333333333333';

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

  statuses_driver text[] := ARRAY['CLEAN','DIRTY','REWASH','BODY','PM','MK','MR','OM','GLASS','TI'];
  destinations    text[] := ARRAY['READY','HOLDING','SERVICE','SHOP','EXIT','RETURN','OTHER'];
  notes_pool      text[] := ARRAY[
    'Lot 3 row 12','Returned with light damage','Low fuel','Smelled like smoke',
    'Customer left phone charger','Tire pressure light','Needs full detail',
    'Drove great, smooth shift','Wash bay queue','Pulled for inspection',
    'Inside lot near gate B','Spotted near building 4','EV charge at 22%',
    'Will hand off to PM team','Heavy rain - parked under cover'
  ];

  shifts int[] := ARRAY[1,2,3];

  -- detailer condition lists
  cond_quick  text[] := ARRAY['QUICK_FLIP'];
  cond_reg    text[] := ARRAY['REGULAR'];
  cond_spiffy text[] := ARRAY['SPIFFY','REGULAR'];
  cond_pet    text[] := ARRAY['PET_HAIR','REGULAR'];
  cond_fuel   text[] := ARRAY['FUEL','QUICK_FLIP'];
  cond_pri    text[] := ARRAY['PRIORITY','REGULAR'];

  i int;
  day_offset int;
  vin text;
  status_pick text;
  dest_pick text;
  note_pick text;
  shift_pick int;
  ts timestamptz;
  lat numeric;
  lng numeric;
  rec_id text;
  job_id uuid;
  conds text[];
  todo jsonb;

BEGIN
  -- ===========================================================
  -- PROFILES
  -- ===========================================================
  INSERT INTO profiles (id, display_name, email, role, home_airport, shuttle_subrole, callbacks_opt_in)
  VALUES
    (driver_id,   'Test Driver',   'driver-test@drivertrax.test',   'driver',   'SDF', NULL, true),
    (cxr_id,      'Test CXR',      'cxr-test@drivertrax.test',      'cxr',      'SDF', NULL, true),
    (detailer_id, 'Test Detailer', 'detailer-test@drivertrax.test', 'detailer', 'SDF', NULL, false)
  ON CONFLICT (id) DO UPDATE
    SET display_name     = EXCLUDED.display_name,
        email            = EXCLUDED.email,
        role             = EXCLUDED.role,
        home_airport     = EXCLUDED.home_airport,
        shuttle_subrole  = EXCLUDED.shuttle_subrole,
        callbacks_opt_in = EXCLUDED.callbacks_opt_in;

  -- ===========================================================
  -- DRIVER RECORDS — 120 across the last 6 days
  -- ===========================================================
  FOR i IN 1..120 LOOP
    day_offset  := (i - 1) / 20;          -- 20 cars/day → 6 days
    vin         := vins[1 + ((i * 7) % array_length(vins,1))];
    status_pick := statuses_driver[1 + ((i * 3) % array_length(statuses_driver,1))];
    dest_pick   := destinations[1 + ((i * 5) % array_length(destinations,1))];
    note_pick   := notes_pool[1 + ((i * 11) % array_length(notes_pool,1))];
    shift_pick  := shifts[1 + (i % 3)];
    ts          := now() - (day_offset || ' days')::interval - ((i % 20) * 18 || ' minutes')::interval;
    lat         := 38.1740 + ((i % 17) * 0.00012);  -- around SDF
    lng         := -85.7360 + ((i % 13) * 0.00018);
    rec_id      := (1700000000000 + i * 1000)::text;

    INSERT INTO records (
      id, user_id, serial_id, status, status_other,
      destination, destination_other,
      no_tag, shuttle, transport,
      shift_num, notes, lat, lng, gps_error,
      tires, vin_data, ts
    ) VALUES (
      rec_id,
      driver_id,
      vin,
      status_pick,
      NULL,
      dest_pick,
      NULL,
      (i % 17 = 0),
      (i % 9  = 0),
      (i % 11 = 0),
      shift_pick,
      note_pick,
      lat,
      lng,
      false,
      CASE WHEN status_pick = 'TI' THEN '["LF","RR"]'::jsonb ELSE NULL END,
      NULL,
      ts
    );
  END LOOP;

  -- ===========================================================
  -- DETAILER RECORDS + DETAIL_JOBS — 100 over the last 5 days
  -- ===========================================================
  FOR i IN 1..100 LOOP
    day_offset  := (i - 1) / 20;          -- 20/day → 5 days
    vin         := vins[1 + ((i * 13) % array_length(vins,1))];
    note_pick   := notes_pool[1 + ((i * 9) % array_length(notes_pool,1))];
    ts          := now() - (day_offset || ' days')::interval - ((i % 20) * 22 || ' minutes')::interval;
    lat         := 38.1745 + ((i % 11) * 0.00010);
    lng         := -85.7355 + ((i % 19) * 0.00015);
    rec_id      := (1800000000000 + i * 1000)::text;

    -- pick a condition mix
    conds := CASE (i % 6)
      WHEN 0 THEN cond_quick
      WHEN 1 THEN cond_reg
      WHEN 2 THEN cond_spiffy
      WHEN 3 THEN cond_pet
      WHEN 4 THEN cond_fuel
      ELSE        cond_pri
    END;

    -- Build a todo_state JSON list. The app expands conditions into tasks;
    -- here we ship a representative QUICK_FLIP/REGULAR checklist so the
    -- history view has something realistic.
    todo := CASE (i % 6)
      WHEN 0 THEN '[
        {"id":"TRASH","label":"Trash","done":true,"note":"","done_at":null},
        {"id":"VACUUM","label":"Vacuum","done":true,"note":"","done_at":null},
        {"id":"DISINFECT","label":"Disinfect","done":true,"note":"","done_at":null},
        {"id":"DEODORIZE","label":"Deodorize","done":true,"note":"","done_at":null},
        {"id":"WINDOWS","label":"Windows","done":true,"note":"","done_at":null},
        {"id":"RESET_RADIO","label":"Reset Radio","done":true,"note":"","done_at":null}
      ]'::jsonb
      WHEN 4 THEN '[
        {"id":"TRASH","label":"Trash","done":true,"note":"","done_at":null},
        {"id":"VACUUM","label":"Vacuum","done":true,"note":"","done_at":null},
        {"id":"DISINFECT","label":"Disinfect","done":true,"note":"","done_at":null},
        {"id":"DEODORIZE","label":"Deodorize","done":true,"note":"","done_at":null},
        {"id":"WINDOWS","label":"Windows","done":true,"note":"","done_at":null},
        {"id":"RESET_RADIO","label":"Reset Radio","done":true,"note":"","done_at":null},
        {"id":"FUEL","label":"Fuel","done":true,"note":"Topped off","done_at":null}
      ]'::jsonb
      ELSE '[
        {"id":"TRASH","label":"Trash","done":true,"note":"","done_at":null},
        {"id":"VACUUM","label":"Vacuum","done":true,"note":"","done_at":null},
        {"id":"DISINFECT","label":"Disinfect","done":true,"note":"","done_at":null},
        {"id":"DEODORIZE","label":"Deodorize","done":true,"note":"","done_at":null},
        {"id":"WINDOWS","label":"Windows","done":true,"note":"","done_at":null},
        {"id":"RESET_RADIO","label":"Reset Radio","done":true,"note":"","done_at":null},
        {"id":"SCRUB","label":"Scrub","done":true,"note":"","done_at":null},
        {"id":"WASH","label":"Wash","done":true,"note":"","done_at":null},
        {"id":"CHECK_FLUIDS","label":"Check Air and Washer Fluids","done":true,"note":"","done_at":null}
      ]'::jsonb
    END;

    -- tracking record (every detailer job writes a row in records)
    INSERT INTO records (
      id, user_id, serial_id, status,
      no_tag, shuttle, transport,
      notes, lat, lng, gps_error, ts
    ) VALUES (
      rec_id,
      detailer_id,
      vin,
      CASE WHEN i % 7 = 0 THEN 'DETAILING' ELSE 'DETAILED' END,
      false, false, false,
      note_pick,
      lat, lng,
      false,
      ts
    );

    -- matching detail_jobs row
    job_id := gen_random_uuid();
    INSERT INTO detail_jobs (
      id, detailer_id, serial_id, record_id,
      condition_tags, todo_state,
      started_at, completed_at, completion_lat, completion_lng
    ) VALUES (
      job_id,
      detailer_id,
      vin,
      rec_id,
      conds,
      todo,
      ts - interval '18 minutes',
      CASE WHEN i % 7 = 0 THEN NULL ELSE ts END,
      CASE WHEN i % 7 = 0 THEN NULL ELSE lat END,
      CASE WHEN i % 7 = 0 THEN NULL ELSE lng END
    );
  END LOOP;

  -- ===========================================================
  -- CXR — announcements & extra_driver_requests
  -- (CXR doesn't log cars, so this is the data they actually produce)
  -- ===========================================================
  INSERT INTO announcements (author_id, body, status, created_at) VALUES
    (cxr_id, 'Welcome to a new shift — please check tire pressures before pulling cars off the lot.', 'open',      now() - interval '6 days'),
    (cxr_id, 'Reminder: park all EVs in rows 8-10 only. Chargers are reserved for fleet vehicles.',   'open',      now() - interval '5 days'),
    (cxr_id, 'Body shop pickup at 2pm today. Avoid lane 4 between 1:30 and 2:30.',                     'open',      now() - interval '4 days'),
    (cxr_id, 'Heavy returns expected this afternoon — please prioritize CLEAN and READY status.',      'open',      now() - interval '3 days'),
    (cxr_id, 'New detailer onboarding tomorrow morning. Show them the wash bay rotation.',             'open',      now() - interval '2 days'),
    (cxr_id, 'Storm watch: secure all cones and move loose items into the shed before 5pm.',           'open',      now() - interval '36 hours'),
    (cxr_id, 'PM team needs all MK vehicles tagged with the yellow slip — no exceptions.',             'open',      now() - interval '1 day'),
    (cxr_id, 'Lost & found: brown wallet turned in from a Camry returned this morning. See front desk.','open',     now() - interval '6 hours'),
    (cxr_id, 'Coffee in the breakroom — courtesy of management. Enjoy the shift.',                     'open',      now() - interval '2 hours'),
    (cxr_id, 'OLD: please ignore — testing announcement system last month.',                           'closed',    now() - interval '30 days'),
    (cxr_id, 'OLD: shift change procedure update has been rolled back.',                               'cancelled', now() - interval '21 days'),
    (cxr_id, 'OLD: holiday schedule for last quarter.',                                                'closed',    now() - interval '45 days');

  INSERT INTO extra_driver_requests (manager_id, shift_time, needed_count, shifts, note, status) VALUES
    (cxr_id, (current_date + interval '1 day')::timestamptz, 3, ARRAY['AM']::text[],         'Heavy return day expected', 'open'),
    (cxr_id, (current_date + interval '1 day')::timestamptz, 2, ARRAY['PM']::text[],         'PM shuttle coverage',       'open'),
    (cxr_id, (current_date + interval '2 days')::timestamptz, 4, ARRAY['AM','MID']::text[],  'Weekend prep',              'open'),
    (cxr_id, (current_date + interval '3 days')::timestamptz, 2, ARRAY['MID']::text[],       NULL,                        'open'),
    (cxr_id, (current_date - interval '1 day')::timestamptz, 2, ARRAY['AM']::text[],         'Filled - thanks',           'filled'),
    (cxr_id, (current_date - interval '2 days')::timestamptz, 3, ARRAY['PM']::text[],         'Filled',                   'filled'),
    (cxr_id, (current_date - interval '5 days')::timestamptz, 1, ARRAY['MID']::text[],        'No-show coverage',         'cancelled');

  RAISE NOTICE 'Seed complete: 120 driver records, 100 detailer records+jobs, 12 announcements, 7 extra-driver requests.';
END $$;

-- ============================================================
-- TEAR DOWN (uncomment to clear seeded rows before re-running)
-- ============================================================
-- DELETE FROM extra_driver_requests WHERE manager_id  = '22222222-2222-2222-2222-222222222222';
-- DELETE FROM announcements         WHERE author_id   = '22222222-2222-2222-2222-222222222222';
-- DELETE FROM detail_jobs           WHERE detailer_id = '33333333-3333-3333-3333-333333333333';
-- DELETE FROM records               WHERE user_id IN (
--   '11111111-1111-1111-1111-111111111111',
--   '33333333-3333-3333-3333-333333333333'
-- );
-- DELETE FROM profiles WHERE id IN (
--   '11111111-1111-1111-1111-111111111111',
--   '22222222-2222-2222-2222-222222222222',
--   '33333333-3333-3333-3333-333333333333'
-- );
