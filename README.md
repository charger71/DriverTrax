# DriverTrax

> A free mobile app for rental car lot drivers — built for Enterprise drivers at Louisville Muhammad Ali International Airport (SDF), useful at any airport.

**[Open the app →](https://charger71.github.io/DriverTrax)**

---

## What is it?

DriverTraxxx is a tool that helps rental car lot drivers track every vehicle they handle during a shift. Instead of writing things down on paper or trying to remember later, you scan the barcode on the car's tag, pick a status, and tap save. Done in about 5 seconds.

It runs on your phone — iPhone or Android — without needing the App Store. You just open a link in your browser and add it to your home screen, like a regular app.

## What can it do?

- 📷 **Scan tag barcodes** with your phone's camera — fills in the Serial ID for you
- 📍 **Records GPS location** for every car so you can see where you logged it
- 🚗 **Looks up vehicle info** automatically from the VIN — year, make, model, fuel type
- 📊 **Shows your stats** — cars per shift, average trip time, weekly trends, personal records
- 🗺️ **Map view** — see every car you logged on a map of the lot
- ⚠️ **Weather alerts** — pulls live SDF weather warnings from the National Weather Service
- 💾 **Backs itself up** — automatically every 30 minutes, plus you can export your data anytime
- 🌐 **Works offline** — once you've opened it, you don't need internet to keep logging cars

## How do I get it?

The app lives at this address:

```
charger71.github.io/drivertrax
```

### On iPhone

1. Open **Safari** (not Chrome — Apple only lets you install apps from Safari)
2. Type the address above and tap **Go**
3. Tap the **Share button** at the bottom (looks like a box with an arrow ⬆️)
4. Scroll down and tap **Add to Home Screen**
5. Tap **Add** in the top right

The app icon will appear on your home screen. Tap it to open — it works just like a regular app.

### On Android

1. Open **Chrome**
2. Type the address above and tap **Go**
3. Chrome should automatically show an "Install" banner — tap **Install**
4. If you don't see the banner, tap the three-dot menu (⋮) and pick **Add to Home screen**

The app icon will appear on your home screen.

> **For full setup instructions with screenshots, see [GUIDE.md](GUIDE.md)**

## How do I use it?

The first time you open it, tap the menu (☰ in the top right) and go to **Profile**. Type your name and pick your home airport, then tap **Save Profile**.

After that, the basic flow is:

1. Tap the big green **SCAN BARCODE** button
2. Point your camera at the tag
3. Pick a Status (Clean, Dirty, PM, etc.)
4. Optional: pick a Destination, mark Shuttle / Transport / No Tag
5. Tap **Save Record**

You're done. Repeat for the next car.

## Things to know

- **Your data stays on your phone.** Nothing gets sent to a server. This means if you lose or replace your phone, your records go with it — so **export your data weekly** to be safe (Menu → Data & Backup → Export All Data).

- **GPS only works once you give permission.** The first time you save a record, your phone will ask if the app can use your location. Tap **Allow**. If you tap Block by mistake, you can fix it in your phone's Settings.

- **The barcode scanner reads two formats:** Code 39 and Code 128. These are the formats Enterprise uses on their tags. If you scan a QR code, it only works if the QR code happens to contain a valid 17-character VIN.

- **The app updates automatically.** When new features are released, you'll get them the next time you open the app. No App Store updates needed.

## Trouble?

| Problem | Fix |
|---|---|
| Buttons not responding | Close and reopen the app, or pull down to refresh |
| Scanner won't open | Check camera permissions in your phone's Settings |
| GPS not working | Check location permissions in Settings |
| Lost my records after switching phones | Records live on your phone — always export weekly to Google Drive or iCloud |
| App won't load | Check your internet connection. After the first load it works offline |

For more help, see [GUIDE.md](GUIDE.md).

## What does it cost?

Nothing. It's free, has no ads, doesn't track you, doesn't sell your data. There isn't even a way to send the developer money — just use it.

## Who built it?

Built for Enterprise lot drivers at SDF Louisville Airport. The code is open source — you can see exactly what it does at the link below.

**Code:** [github.com/charger71/drivertrax](https://github.com/charger71/drivertrax)

## What's coming next?

We're working on:

- **Cloud sync** so your records work across multiple devices
- **Driver announcements** — managers can post updates that appear right in the app
- **Push notifications** for weather, shift reminders, and "extra drivers needed" requests
- **Manager dashboard** with fleet-wide stats

See ROADMAP.md (*coming soon*) for the full list.

---

*DriverTrax — built for the lot, by someone who's worked it.*
