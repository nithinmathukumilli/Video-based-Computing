# Cafeteria seats

Live seat availability for the cafeteria. People mark seats free when they finish eating. People waiting see which tables fit their group, get an alert, and can hold seats for a few minutes.

- No dependencies. Needs Node 18 or newer.
- One server holds the shared state, so two people can never claim the same seats.
- Pages update instantly (Server-Sent Events), no refreshing.
- Sign-in is your company Microsoft account, handled by Azure App Service Authentication. The app never sees passwords.
- Other people's identities are never sent to the browser. Everyone only sees their own hold.

## Try it on your computer

```
DEV_USER=you@company.com node server.js
```

Open http://localhost:3000. In dev mode everyone is signed in as `DEV_USER` and is an admin. To test two people, open a second browser and send the header `x-dev-user: other@company.com` (a header-editing browser extension works), or use curl.

Never set `DEV_USER` in production: it turns sign-in off.

## Quick start on Windows

Copy `.env.example` to `.env` and fill in what you need. To start with the prepared floor map and camera seats instead of the plain starting layout, also copy the seed file (the app saves its live state in `data/`, which Git ignores):

```
copy seed\state.json data\state.json
```

Do this before the first start. The seed has every seat taken, no holds and no people recorded. Then double-click:

| File | What it does |
|---|---|
| `restart-canteen.bat` | Starts (or restarts) the server and opens the page |
| `start-demo.bat` | Starts the server and shares it through a temporary public link (needs `cloudflared`) |
| `restart-server.bat` | Restarts just the server |
| `run-camera.bat` / `run-camera-loop.bat` | Runs the camera check once / every 2.5 minutes (see "Live camera feed") |
| `test-personal-alert.ps1` | Sends a sample personal alert to your Teams flow |

Set `DEMO_LOGIN=1` in `.env` for a demo where people type their work email instead of signing in with Microsoft. It is not secure: anyone with the link can use any name, so never use it in production.

## Floor map

The page shows a top-down map of the cafeteria. Tap a table to see its seats and to hold, sit or free seats. Tables that fit your group have a green ring.

The starting layout is only an approximation made from photos. To match the real room, sign in as an admin, open "Set up tables", press "Move tables on map" and drag each table to where it really is. Positions save when you let go and everyone sees them. "Add table" lets you pick a shape (round, long, booth sofa, high counter); new tables appear in the middle of the map until you move them. Fixed features (windows, hedge, kitchen, entrance) are drawn by `public/index.html` and `public/style.css`.

## Teams channel alerts

The server can post a card to a Teams channel when seats open ("Window 1: 2 free, 5 of 98 seats free now", with a button to open the app).

1. In Teams, open the channel, choose "Workflows", and use the template "Post to a channel when a webhook request is received". Copy the web address it gives you. Treat it like a password: anyone who has it can post to the channel.
2. Add it as an app setting `TEAMS_WEBHOOK_URL`. Also set `PUBLIC_URL` to your app's address so the card has an open button.
3. Restart the app. Alerts are off whenever `TEAMS_WEBHOOK_URL` is empty.

To avoid flooding the channel, the server posts only when at least `TEAMS_ALERT_MIN_SEATS` seats (default 2) have been freed with "I'm done eating", and at most once per `TEAMS_ALERT_COOLDOWN_SECONDS` (default 300). Seats freed in between are added up into the next card. Holds, released holds and the admin "Free every seat" button never trigger a post. A failed post is logged (without the address) and not retried.

## Personal Teams messages ("Alert me when seats open")

When someone taps "Alert me when seats open", that tap is their permission for us to message them on Teams. The server remembers their email and group size (in memory only), sends one personal message the first time a table that fits their group opens up, and then forgets them. Their email is only ever sent to your Teams flow, never to other people's browsers. If a table already fits when they tap, they are messaged the next time a fitting table opens up. A tap lasts `TEAMS_PERSONAL_TTL_MINUTES` (default 120).

The app does not talk to Teams directly. It calls a Power Automate flow that you create, and the flow posts the message:

1. In Power Automate, create a flow that starts with a trigger that gives you a web address (for example "When a Teams webhook request is received", or "When an HTTP request is received"; which one is available depends on your licence, so ask IT).
2. Add a Teams action, either:
   - **"Post message in a chat or channel"** (simplest): post as the Flow bot, in "Chat with Flow bot", Recipient = the `to` value from the request, Message = the `title` and `message` values (and `link`). Or
   - **"Post card in a chat or channel"**: same Post as, Post in and Recipient, and set the Card to the `card` value from the request (an Adaptive Card the server builds). If the flow complains about the card, use the expression `string(triggerBody()?['card'])`. The error "Property 'type' must be 'AdaptiveCard'" means the Card field holds something that is not that card.
3. Save the flow and copy the web address from the trigger. Treat it like a password.
4. Set `TEAMS_PERSONAL_WEBHOOK_URL` to that address and restart the app. The page then tells people about the Teams message. When it is empty, the button works only inside the open page, as before.

The request the server sends is JSON: `{ "to": "email", "title": "...", "message": "...", "table": "Round 1", "free": 2, "link": "https://...", "card": { ...Adaptive Card... } }`. A failed call is logged (without the address) and not retried. This setting is separate from the channel alerts above.

## Live camera feed (proof of concept)

The `poc-vision/` folder is an experiment: it looks at camera pictures of the cafeteria, finds the people (YOLOX, run locally through OpenCV, nothing leaves the PC), decides which marked seats are taken, and posts the counts to the app (`POST /api/camera`). The seat map then shows those tables as "from camera". A tap on "Sit here" at a camera-watched table counts for `CAMERA_TAP_GRACE_MINUTES` before the camera decides.

Setup:

1. Set `CAMERA_KEY` in `.env` (any long random text). The endpoint is off while it is empty.
2. Create the Python environment and download the models (they are not in the repository). Details and licences are in [poc-vision/README.md](poc-vision/README.md).
3. Mark the seats on the calibration page (`/calibrate.html`), then run `run-camera.bat`.

The sample photos are Wikimedia Commons images (credits in `poc-vision/images/CREDITS.md`). This part is a POC: it uses still pictures, not a live video stream.

## Keeping your settings in a file (`.env`)

Instead of setting variables in the terminal every time, copy `.env.example` to `.env` (same folder) and fill in the values, such as `TEAMS_PERSONAL_WEBHOOK_URL`. The app reads it when it starts. Real environment settings, such as Azure app settings, override the file. `.env` holds secrets, so do not share it, do not commit it (`.gitignore` already skips it), and leave it out of any zip you deploy. On Azure, use app settings instead.

## Settings

| Setting | What it does | Default |
|---|---|---|
| `ADMINS` | Comma-separated emails allowed to add or remove tables and reset everything | none (nobody) |
| `HOLD_MINUTES` | How long a hold lasts before the seats are released | 5 |
| `DATA_DIR` | Where the state file is saved | `./data` |
| `PORT` | Port to listen on (Azure sets this) | 3000 |
| `TEAMS_WEBHOOK_URL` | Teams Workflows web address for channel alerts (secret) | off |
| `TEAMS_PERSONAL_WEBHOOK_URL` | Power Automate flow address for personal Teams messages (secret) | off |
| `TEAMS_PERSONAL_TTL_MINUTES` | How long a tap on "Alert me" lasts | 120 |
| `PUBLIC_URL` | Address shown as the button on the Teams card | none |
| `TEAMS_ALERT_MIN_SEATS` | Seats that must be freed before a post | 2 |
| `TEAMS_ALERT_COOLDOWN_SECONDS` | Shortest time between posts | 300 |
| `CAMERA_KEY` | Key the camera script sends in `X-Camera-Key` (secret) | off |
| `CAMERA_TAP_GRACE_MINUTES` | How long a "Sit here" tap counts at a camera-watched table | 10 |
| `CAMERA_FRESH_MINUTES` | Minutes without camera news before "from camera" is dropped | 10 |
| `DEMO_LOGIN` | `1` = people type their email to sign in (demo only, not secure) | off |
| `DEMO_EMAIL_DOMAIN` | Email domain accepted by the demo sign-in | `accordion.com` |

## Deploy on Azure App Service

You will probably need your IT team for the sign-in step (it registers an app in your company's Entra ID).

1. **Create the web app.** Linux, Node 20 LTS. A small plan (B1) is enough. Keep it at **one instance** (see "Limits" below).

   ```
   az group create -n canteen-rg -l <your-region>
   az appservice plan create -g canteen-rg -n canteen-plan --is-linux --sku B1
   az webapp create -g canteen-rg -p canteen-plan -n <unique-app-name> --runtime "NODE:20-lts"
   ```

2. **Add settings.**

   ```
   az webapp config appsettings set -g canteen-rg -n <unique-app-name> \
     --settings ADMINS="you@company.com" DATA_DIR=/home/data HOLD_MINUTES=5
   ```

   `/home` is the part of the disk that survives restarts on Linux App Service.

3. **Upload the app.**

   ```
   az webapp deploy -g canteen-rg -n <unique-app-name> --src-path canteen-seats.zip --type zip
   ```

   (Command names can change between Azure CLI versions. The portal's Deployment Center does the same thing.)

4. **Turn on sign-in.** In the Azure portal open the web app, then Settings > Authentication > Add identity provider > Microsoft. Choose your company directory (current tenant only), set "Require authentication", and for unauthenticated requests choose "HTTP 302 redirect". Save.

   After this, nobody reaches the app without signing in, and the app receives the person's email.

5. **Check it.** Open `https://<unique-app-name>.azurewebsites.net`, sign in, free a seat on one phone and watch it appear on another.

6. **Share it.** Put a QR code of the address on a poster at the cafeteria entrance and post the link in Teams.

## Using it from Teams

Posting the link in a Teams channel works today: people tap it and it opens in their browser or the Teams in-app browser, already signed in.

Showing it as a tab *inside* Teams needs a little extra work. Teams tabs load pages inside a frame, and the sign-in redirect used above usually does not work inside that frame. The proper fix is a small Teams app package that uses Teams single sign-on. That fits naturally with the next stage (channel and personal alerts), so I left it out of this one.

## Limits (and what to do when you outgrow them)

- **One server instance only.** State lives in memory and a file, and live updates are held by that one process. For thousands of people or several instances, move state to a database (Cosmos DB or Azure SQL) and use Azure SignalR for live updates.
- **Alerts only fire while the page is open.** Browsers pause background tabs on some phones. Alerts that reach people anywhere are the Teams stage.
- **It trusts people.** Someone can mark seats free while still sitting. Holds expire by themselves, so a no-show costs a table at most a few minutes.
- **Last 300 ms of changes can be lost** if the server is killed abruptly. A normal restart saves everything.

## Files

- `server.js`: the whole backend
- `public/`: the page (`index.html`, `style.css`, `app.js`) and the calibration page (`calibrate.html`, `calibrate.js`)
- `poc-vision/`: the camera proof of concept (Python)
- `*.bat`, `*.ps1`: Windows helper scripts (see "Quick start on Windows")
- `GET /healthz`: returns `ok` (useful for uptime checks)
