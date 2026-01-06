param(
  [Parameter(Mandatory=$true)]
  [string]$Url
)

$body = @{
  photos = @(
    @{
      filename = "test.jpg"
      data     = "test"
    }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri $Url -Method POST -ContentType "application/json" -Body $body

