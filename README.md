# BC Oseberg Monitor

Automated monitor for the Oseberg integration log in Microsoft Dynamics 365 Business Central.

Checks the integration log on a schedule, matches failed jobs against configurable rules, and automatically requeues or marks them as manually handled — then posts a summary to Slack.

---

## How it works

1. Opens Business Central using a saved browser session
2. Navigates to the Oseberg integration log filtered on failed jobs (`ProcessStatus = 3`)
3. Reads each failed entry and checks the error message against your rules
4. Takes action: requeue the job or mark it as manually handled
5. Posts a summary to Slack
6. Runs automatically via GitHub Actions — no server or local machine required

---

## Requirements

- Node.js v18 or higher
- A GitHub account (free tier is sufficient)
- A Business Central user with access to the Oseberg integration log
- A Slack workspace with a bot token (optional but recommended)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/bc-oseberg-monitor.git
cd bc-oseberg-monitor
npm install
npx playwright install chromium
```

### 2. Configure

Edit `config/rules.json` with your BC environment details:

```json
{
  "settings": {
    "bcUrl": "https://businesscentral.dynamics.com/YOUR_ENVIRONMENT/?company=YOUR_COMPANY&dc=0",
    "logPageUrl": "https://businesscentral.dynamics.com/YOUR_ENVIRONMENT/?company=YOUR_COMPANY&page=YOUR_PAGE_ID&filter=OSB_INT_LogEntry.ProcessStatus%20IS%20%273%27&dc=0",
    "slackChannelId": "YOUR_SLACK_CHANNEL_ID"
  }
}
```

**Finding your values:**

| Value | Where to find it |
|-------|-----------------|
| `YOUR_ENVIRONMENT` | The path segment after `businesscentral.dynamics.com/` in your BC URL (e.g. `Production`) |
| `YOUR_COMPANY` | The `company=` parameter in your BC URL |
| `YOUR_PAGE_ID` | Open the Oseberg integration log in BC, check the `page=` parameter in the URL |
| `YOUR_SLACK_CHANNEL_ID` | Right-click a channel in Slack → View channel details → Channel ID at the bottom |

### 3. Log in to BC (one time)

```bash
npm run login
```

This opens a visible browser window. Log in with your credentials and MFA, navigate to the BC start page, then press Enter in the terminal. Your session is saved to `.auth/bc-state.json`.

> ⚠️ Never commit `.auth/` to git — it is already excluded in `.gitignore`

### 4. Test locally

```bash
npm run monitor:visible   # visible browser (recommended for first test)
npm run monitor           # headless
```

---

## Adding rules

Edit `config/rules.json` — no code changes required:

```json
{
  "rules": [
    {
      "id": "lock-conflict",
      "description": "Record locked by another session - safe to requeue",
      "matchContains": [
        "Vi kan ikke lagre endringene akkurat nå fordi en oppføring i tabellen"
      ],
      "action": "requeue",
      "slackEmoji": "🔄"
    },
    {
      "id": "my-second-rule",
      "description": "Some other error that needs manual review",
      "matchContains": [
        "Part of the error message here"
      ],
      "action": "manual",
      "slackEmoji": "🔧"
    }
  ]
}
```

**`action` values:**
- `requeue` — sets the job back to queue status
- `manual` — marks the job as manually handled

**`matchContains`** is a list — the job matches if the error message contains *any* of the strings (case insensitive).

Jobs with error messages that don't match any rule are logged and skipped — they will appear in the Slack summary as requiring manual review.

---

## GitHub Actions (automated scheduling)

Push your repo to GitHub and add the following repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|-------|
| `BC_AUTH_STATE` | Your auth state file, base64 encoded: `base64 -w 0 .auth/bc-state.json` (Linux) or `base64 -i .auth/bc-state.json` (Mac) |
| `SLACK_BOT_TOKEN` | Your Slack bot token (`xoxb-...`) |
| `GH_PAT` | A GitHub Personal Access Token with `repo` and `secrets` write scope — used to automatically refresh the auth state after each run |

The workflow runs every 30 minutes on weekdays between 07:00–18:00 CET. You can adjust the schedule in `.github/workflows/monitor.yml`.

You can also trigger it manually from the **Actions** tab in GitHub.

### Auth state expiry

The BC session is automatically saved after each successful run to keep it fresh. If it expires:

1. Run `npm run login` locally
2. Update the `BC_AUTH_STATE` secret: `base64 -w 0 .auth/bc-state.json`

---

## Column index configuration

This tool reads the Oseberg log table by column position. The default column indices are:

| Index | Field |
|-------|-------|
| 2 | Log number |
| 4 | Source record ID |
| 29 | Process status |
| 33 | Message / error text |

If your Oseberg setup has a different column order, you can adjust these in `src/monitor.ts` in the `readLogEntries` function:

```typescript
logNo: getText(2),
sourceRecord: getText(4),
status: getText(29),
message: getText(33),
```

To find your column indices, open the integration log in BC, open the browser developer tools (F12), and inspect the `tr[rowkey]` elements inside `iframe.designer-client-frame`.

---

## Slack notifications

Example notification posted to your Slack channel after a run:

```
BC Integrasjonslogg – automatisk retting
📊 Sjekket: 3 feilede jobber
🔄 Satt tilbake i kø: 2
⚠️ Ikke matchet (krever manuell sjekk): 1

Detaljer:
🔄 `OSB_TMC_OrderHeader: 2000730066` → Satt i kø
   Record locked by another session - safe to requeue
🔄 `OSB_TMC_OrderHeader: 2000730067` → Satt i kø
   Record locked by another session - safe to requeue
⚠️ `OSB_TMC_OrderHeader: 2000730068` → Ikke matchet – manuell sjekk
```

---

## Project structure

```
bc-oseberg-monitor/
├── .github/workflows/
│   └── monitor.yml       ← GitHub Actions schedule
├── config/
│   └── rules.json        ← Your rules and BC settings
├── src/
│   ├── monitor.ts        ← Main logic
│   └── login.ts          ← One-time login helper
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Contributing

Pull requests are welcome. If you have additional error message patterns that are safe to auto-requeue, feel free to submit them.

---

## License

MIT
