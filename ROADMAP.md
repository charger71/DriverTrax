# DriverTrax — Roadmap

> Features planned, in progress, or under consideration for future releases.

---

## ✅ V1 — Released

- Barcode scanner (Code 39 + Code 128)
- GPS tagging on every entry
- TI status with tire selector
- Shuttle + Transport checkboxes
- No Tag flag
- VIN decode via NHTSA (auto year/make/model)
- Vehicle silhouette icons by body type
- Weather alerts via NWS API (SDF)
- Random car quote on dashboard
- SIPP codes training table
- Profile with driver name + home airport
- Data & Backup (auto 30min, export/import JSON, restore)
- Dashboard 7-day shift breakdown
- Shift map (Leaflet + OpenStreetMap, per shift)
- Records map view (all filtered results on map)
- Dashboard time ranges (30 days, 3 months, 6 months, 1 year, all time)
- Personal records — best shift, most cars in a day, streak counters

---

## 🚀 V2 — Released

- Three-file architecture (`index.html`, `app.css`, `app.js`)
- `createMap()` and `createNumberedMarker()` helper functions to deduplicate map setup
- Schema versioning with auto-migration on app load
- Global error handlers for uncaught exceptions
- Sanitizer audit — all user input fields properly escaped
- Status options expansion (REWASH, TOP OFF FLUID, OM, AUDIT FAIL)

---

## 🔜 V3 — High Priority

### Cloud Sync (Firebase)
- Real-time sync across devices via Firebase Firestore
- Solves device loss/theft — no data lost if phone is replaced
- Foundation for all multi-user features below
- Photo upload to Firebase Storage (deferred from V1)

### Users & Roles
- Driver, CXR, Manager role distinction
- PIN or passcode per user
- Role/PIN distinction for Shuttle Driver vs Passenger
- Per-user records linked to their account

### Driver Announcements
- Managers/CXRs post updates, car needs, lost & found
- Dismissible banner in the app
- Push notifications when new announcements are posted

### Push Notifications
- Web Push API + service worker for native-style notifications
- Works on Android Chrome / installed PWA (full support)
- Works on iOS 16.4+ when app is installed to home screen
- Requires opt-in permission prompt during onboarding
- Backend webhook needed for managers to push notifications (Firebase Cloud Messaging)
- Quiet hours setting so off-shift drivers aren't disturbed

**Notification triggers:**
- New driver announcements from managers/CXRs
- Severe weather alerts at the airport
- Shift reminders (configurable per-driver — e.g. "30 min before your shift")
- **Extra drivers needed** — managers send a request when the lot is short-handed; available off-shift drivers can opt in
- Lost & found alerts
- End-of-shift CSV export reminder
- Weekly summary push every Monday morning

### Extra Drivers Request (Manager Lifesaver)
- Manager taps "Request Extra Drivers" button — sends push to all opted-in off-shift drivers
- Includes shift time, expected duration, and any incentive note ("time and a half")
- Drivers tap "I can come in" or "Not available" right from the notification
- Manager sees a live count of who has accepted
- Auto-cancels when the requested number of drivers have responded yes
- Drivers can set "available for callbacks" toggle in their profile

**Why this matters for managers:**
- One tap blasts to every available driver — no more chain phone calls
- Automatic audit trail of who was asked and who responded (HR/scheduling record)
- Fairness rotation — system can rotate who gets called first based on who came in last time
- Coverage prediction — over time the data shows which drivers reliably accept
- Drivers respond with one tap from their lock screen, no callback needed

### Manager Dashboard
- Separate PIN-protected view showing all drivers' entries
- Real-time fleet-wide stats — total cars, status breakdown, most common destination
- Per-driver leaderboard with cars/hour and shift counts
- Live map showing all driver activity for the current day
- Shift coverage view — who's clocked in, who's late, who's on break

### Shift Swaps
- Drivers can request to swap shifts with each other through the app
- Other drivers see swap requests and can accept
- Manager approval before swap is finalized
- Uses same push notification framework

### Group Chat / Team Messaging
- Lot-wide channel for active shift drivers
- Manager broadcast channel for important updates
- Quick replies, photo attachments
- Built on the same push notification infrastructure

### Driver of the Month
- Auto-calculated from the data already collected
- Most cars logged, fastest avg trip time, longest streak, fewest no-tags
- Surfaces in dashboard with badge
- Optional public leaderboard

### Pickup + Dropoff GPS (Trip Tracking)
- Capture two GPS points per record: where the car was picked up, where it was dropped off
- Uses an "implicit chain" workflow — previous record's dropoff becomes next record's pickup automatically
- Zero extra taps for the driver, no extra GPS battery cost
- Resets if more than 15 minutes pass between records (lunch breaks, end of shift)
- Unlocks for individual drivers:
  - Distance walked per shift
  - Actual trip time (driving) vs total gap time (driving + walking)
  - Personal map of every car touched with route arrows
- Unlocks for managers (with cloud sync):
  - Heat map of busiest lot pickup zones
  - Average trip time by route (e.g. "QTA → garage averages 4 min")
  - Fleet-wide distance and movement patterns
  - Bottleneck detection
- Schema requires `pickupLat`, `pickupLng`, `pickupTimestamp` fields — designed alongside Firestore schema

---

## 📋 Smaller Improvements

### Dashboard & Analytics
- Average cars per hour on dashboard (global, not just current shift)
- Weekly summary screen — total cars, avg trip time, no-tag count, most common status
- Export to PDF — formatted shift report

### Maps
- Click any record to show its GPS location on a map

### Entry Form
- Color picker or dropdown for vehicle color (tints the SVG icon)
- Photo capture option per entry (after Firebase Storage)

### Records
- Swipe to delete on record cards
- Bulk delete / bulk export

### Data
- Auto-email CSV export to manager on shift end
- Google Drive or iCloud auto-upload for backups

### Scanner
- Continuous scan mode — log multiple barcodes without closing scanner

### UX
- Onboarding flow — first-launch wizard for new drivers
- App version badge in menu footer with "update available" notice
- Distinct haptic patterns for scan success vs save vs error

---

## 🔧 Technical

### PWA & GitHub
- Proper `manifest.json` in repo root (richer Android install prompts)
- Service worker for full offline support and push notifications
- GitHub Actions auto-deploy on push
- Lighthouse PWA score badge in README

### Performance
- Lazy load records list (virtual scroll for large datasets)
- Compress/prune old records after configurable retention period
- IndexedDB migration for photo storage (vs localStorage)

---

## 💡 Under Consideration

- Admin dashboard — fleet-wide analytics across all branches
- Multi-branch support — sync drivers/managers across multiple Enterprise locations
- Offline map tiles — lot map works without internet
- Training section expansion — video links, step-by-step guides, quizzes
- Role-based training content — different content per role
- Apple Watch companion — quick scan + status entries from wrist
- Voice notes on entries

---

*Last updated: May 2026*
