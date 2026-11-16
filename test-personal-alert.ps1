# Sends a sample personal alert to your Teams flow, the same way the app does.
# Use it to check the flow works before you set TEAMS_PERSONAL_WEBHOOK_URL in the app.
#
#   $env:TEAMS_PERSONAL_WEBHOOK_URL = "<the address from your flow's trigger>"
#   .\test-personal-alert.ps1 -To you@company.com
#
# The address is a secret: type it in your own terminal, never paste it into chats or commit it.
param([Parameter(Mandatory = $true)][string]$To)

$url = $env:TEAMS_PERSONAL_WEBHOOK_URL
if (-not $url) { Write-Error 'Set $env:TEAMS_PERSONAL_WEBHOOK_URL first.'; exit 1 }

$body = @{
  to      = $To
  title   = 'Seats just opened in the canteen'
  message = 'Round 1 has 2 free, enough for your group of 2. Open the seat map to hold them.'
  table   = 'Round 1'
  free    = 2
  link    = 'https://example.com/canteen'
  card    = @{
    '$schema' = 'http://adaptivecards.io/schemas/adaptive-card.json'
    type      = 'AdaptiveCard'
    version   = '1.3'
    body      = @(
      @{ type = 'TextBlock'; text = 'Seats just opened in the canteen'; weight = 'Bolder'; size = 'Medium'; wrap = $true },
      @{ type = 'TextBlock'; text = 'Round 1 has 2 free, enough for your group of 2. Open the seat map to hold them.'; wrap = $true }
    )
  }
} | ConvertTo-Json -Depth 8

try {
  $r = Invoke-WebRequest -Uri $url -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing
  Write-Host "Flow accepted the request (HTTP $($r.StatusCode)). Check Teams for a message from the Flow bot to $To."
} catch {
  Write-Host "The flow did not accept the request: $($_.Exception.Message)"
  exit 1
}
