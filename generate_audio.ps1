Add-Type -AssemblyName System.Speech
$cues = @{
    "guard_dropping"     = "Guard"
    "jab_loading"        = "Slip left"
    "right_hand_loading" = "Duck right"
    "stance_switch"      = "Stance switch"
    "closing_distance"   = "Circle out"
    "overextended"       = "Counter now"
    "fatigue_low_guard"  = "Hands up"
    "all_clear"          = "Clear"
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 2

foreach ($pair in $cues.GetEnumerator()) {
    $wavPath = "D:\Salmancz\jev-fight-coach\frontend\audio\$($pair.Key).wav"
    $mp3Path = "D:\Salmancz\jev-fight-coach\frontend\audio\$($pair.Key).mp3"
    $synth.SetOutputToWaveFile($wavPath)
    $synth.Speak($pair.Value)
    Copy-Item -Path $wavPath -Destination $mp3Path -Force
}
$synth.Dispose()
Write-Host "Audio clips generated successfully."
