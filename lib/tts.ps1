param(
  [Parameter(Mandatory=$true)][string]$TextPath,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [string]$VoiceName = "Microsoft Zira Desktop",
  [int]$Rate = -1
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice($VoiceName)
} catch {
  # fall back to whatever default voice is installed
}
$synth.Rate = $Rate
$synth.SetOutputToWaveFile($OutPath)
$text = Get-Content -Path $TextPath -Raw -Encoding UTF8
$synth.Speak($text)
$synth.Dispose()
