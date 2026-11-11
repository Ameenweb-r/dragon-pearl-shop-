# Dragon Pearl Shop — 3D glass online store with a private admin panel

No dependencies. Needs only **Node.js 18+** (https://nodejs.org).

## Run it
```
cd shop
node server.js
```
- Shop:  http://localhost:3000/
- Admin: http://localhost:3000/admin

On the **first run** the terminal prints the owner username (`owner`) and a one-time temporary password.
Log in at `/admin`; the site forces you to choose your own password before anything else.
Then turn on **2FA** in the Security tab.

## What the owner can do (Admin → tabs)
| Tab | Controls |
|---|---|
| Orders | See every order (customer, address, phone, items, payment). Change order status, mark payments paid, cancel (stock is restored), delete. |
| Products | Add / edit / hide / delete products, upload up to 6 photos, set price, discount %, stock, category. |
| Store & prices | Shop name, tagline, currency, delivery fee, free-delivery limit, store-wide sale %. |
| Payments | bKash / Nagad / Rocket numbers, card gateway keys, cash on delivery on/off. |
| Appearance | Background (built-in 360° scene, your own 360° photo/video, or a flat photo/video), rotation speed, zoom, colours, glass opacity/blur/roundness, heading + body fonts. Live preview, then Save. |
| Security | Change password, set up 2FA (Google Authenticator / Authy). |

Discount rule: a product's own discount % wins; if it is 0, the store-wide sale % applies.

## 360° background
- `default`: built-in misty mountains + Chinese pagodas and lanterns, auto-rotating, drag to look around.
- `image360` / `video360`: upload an **equirectangular 2:1 panorama** (JPG/PNG/WEBP up to 10 MB, MP4/WEBM up to 60 MB).
- `image` / `video`: an ordinary picture or looping video.

## Payments
- **bKash / Nagad / Rocket**: customers "Send Money" to *your* number and type the TrxID + their number.
  You check your app and press **Mark paid & confirm**. Duplicate TrxIDs are rejected. (These wallets' official
  merchant APIs need a merchant contract; this manual flow works for any personal/agent/merchant number.)
- **Card**: uses **SSLCommerz** (works for Bangladesh merchants; Stripe is not available there). Enter your Store ID and
  password in Admin → Payments. Keep **Test mode** on until you've tested with sandbox credentials. Card numbers are entered on
  the bank's page and never touch your server. Payment is confirmed server-to-server before an order is marked paid.
  *This integration was written to SSLCommerz's documented API but could not be tested with real credentials here — test it in sandbox first.*
- **Cash on delivery**: on/off.

## Putting it online safely
1. Host it on a Node-capable host (VPS, Render, Railway, etc.) **behind HTTPS** (the host's built-in HTTPS, Caddy, nginx or Cloudflare).
   Passwords and sessions must never travel over plain http.
2. Environment variables:
   - `HTTPS=1` (or `TRUST_PROXY=1` when a proxy sets `X-Forwarded-Proto`) → marks cookies `Secure`, enables HSTS.
   - `PUBLIC_URL=https://yourshop.com` → used for card-payment return links.
   - `ADMIN_PATH=/my-secret-door` → optional: moves the admin page off `/admin`.
   - `ADMIN_USER`, `ADMIN_PASSWORD` (10+ chars) → set your own first-run login instead of a random one.
   - `PORT`, `HOST`, `DATA_DIR` (put this on a persistent disk!).
3. **Back up the `data/` folder** (db.json + uploads). It holds products, orders and settings.

## Security built in
- Only one owner account exists; there is **no sign-up page or API**, so nobody can make themselves admin.
- Passwords: salted scrypt hashes. Optional TOTP 2FA. 5 failed logins → 15-minute lockout; logins are slowed down.
- Sessions: random 256-bit ID in an `HttpOnly`, `SameSite=Strict` cookie; every change also needs a secret CSRF token; idle/absolute expiry.
- Everything private (orders, payment numbers, gateway password) is only sent to a logged-in owner. The gateway password is never sent to any browser.
- Prices/totals are recomputed on the server; stock, quantities, payment methods are validated.
- Strict Content-Security-Policy (no inline scripts), no `innerHTML` anywhere, clickjacking/MIME-sniffing protection.
- Uploads are accepted only if the file's real signature is JPG/PNG/WEBP/MP4/WEBM, stored under random names.
- Rate limits on logins, orders, tracking and payment starts.

No website can be promised "unhackable". Keep Node updated, use a long unique password + 2FA, keep HTTPS on, and back up `data/`.

## Files
```
server.js        backend (API, security, payments, uploads)
public/index.html, store.js     storefront
public/admin.html, admin.js     owner panel
public/bg.js     360° WebGL background engine
public/common.js, style.css     shared helpers, 3D glass + jelly-button styles
data/            created on first run (db.json, uploads/)
```
