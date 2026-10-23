# Split the bill

A tiny installable web app (PWA) for splitting restaurant bills with friends. No server, no accounts.

- Photo of the receipt is read on-device (Tesseract.js), then you review the items.
- The whole bill is encoded inside the share link (after the `#`, never sent to a server).
- Friends open the link, pick their name and tick what they had; they see their own total.
- They send back a short `BSR:` reply code; paste any number of them into the host app to see who owes what.
- Your bills are stored only in your browser (`localStorage`). Use "Back up bills" to export a file.

## Deploy
Static files only. Serve this folder from GitHub Pages (Settings → Pages → `main` / root), Netlify, or Cloudflare Pages.
Open the site on your phone and "Add to Home Screen".

The first photo scan downloads the OCR engine (~15 MB) from jsDelivr; after that it is cached.
