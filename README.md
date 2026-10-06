# Bonus Registration + Consent-Based Live Location

## Features
- Premium mobile registration UI
- Initial location permission required before registration
- Gift icon: tap 5 times -> Admin PIN
- Default admin PIN: 6123 (change it in `.env`)
- Server-side admin authentication
- bKash / Nagad number collection
- Telegram Bot Token + Chat ID configuration in Admin
- Bot token is encrypted on disk and never returned to the browser
- Optional LIVE location sharing after registration
- Live sharing only runs while the page is open and the user has explicitly started it
- A visible LIVE indicator and STOP control remain on screen while sharing
- Admin automatically refreshes every 10 seconds
- Admin can see latest location and location history
- Each stored location point is retained for no more than 30 days, then removed

## Important privacy / browser behavior
This project does NOT secretly track someone in the background.
A normal website cannot reliably track a phone for 30 days after one permission prompt.
Live tracking uses `navigator.geolocation.watchPosition()` and works while the page remains active/open and browser permission remains granted.

For true background location in a mobile app, you would need a native Android/iOS app and the operating system's explicit background-location permission and disclosure.

## Run
1. Install Node.js 18+
2. Copy `.env.example` to `.env`
3. Change `APP_SECRET` to a long random value
4. Run:

npm install
npm start

Then open:
http://localhost:3000

For a public website, use HTTPS. Geolocation generally requires HTTPS (localhost is allowed for development).


## Register button location flow
- No separate Location Allow button.
- Complete the form and check the consent box.
- Press CREATE ACCOUNT / Register.
- The browser then shows its Location Allow / Block prompt.
- Allow: current location is captured and registration continues.
- Block: registration stops and the user is asked to allow location.
