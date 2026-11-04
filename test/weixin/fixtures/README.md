# Weixin media samples

`sample.png` is a generated 64×64 solid green PNG. `sample.mp4` is a generated
0.5-second 64×64 H.264/yuv420p MP4 at 10 fps. Neither contains user data.

The tests read these actual media files, encrypt/decrypt them through the Tencent
wire format, and compare exact bytes after the complete Cardbush tool round trip.
Runtime tests additionally inject the PNG into model image input. They do not
claim a simulated model has interpreted the video or a real phone has received it.

Equivalent fixtures can be generated with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=green:s=64x64 -frames:v 1 sample.png
ffmpeg -f lavfi -i color=c=green:s=64x64:r=10 -t 0.5 -c:v libx264 -pix_fmt yuv420p -movflags +faststart sample.mp4
```

The file fixture is an inline UTF-8 text buffer in `../media-helpers.mjs`.
