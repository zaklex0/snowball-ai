param([string]$Out = "$PSScriptRoot\demo")
# A neutral demo video for the screenshots of the guides: a calm background with a title and a Russian voice
# (the Windows voice «Irina»), with clear pauses between sentences. Needs ffmpeg in PATH. The text is in demo-texts.json.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Irina Desktop')
$s.SetOutputToWaveFile("$Out\speech.wav")
$p = New-Object System.Speech.Synthesis.PromptBuilder([System.Globalization.CultureInfo]::GetCultureInfo('ru-RU'))
$texts = Get-Content "$PSScriptRoot\demo-texts.json" -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($t in $texts) { $p.AppendText($t); $p.AppendBreak([TimeSpan]::FromMilliseconds(1600)) }
$s.Speak($p)
$s.Dispose()
$font = 'C\:/Windows/Fonts/segoeuib.ttf'
$vf = "drawtext=fontfile='$font':text='Нейросети для видео':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=h/2-70," +
      "drawtext=fontfile='$font':text='урок 1 — промты':fontcolor=0xFFE2CF:fontsize=40:x=(w-text_w)/2:y=h/2+20"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=0x3A2A3F:s=1280x720:r=30" -i "$Out\speech.wav" -shortest -vf $vf -c:v libx264 -pix_fmt yuv420p -c:a aac "$Out\урок — озвучка.mp4"
Write-Output "$Out\урок — озвучка.mp4"

