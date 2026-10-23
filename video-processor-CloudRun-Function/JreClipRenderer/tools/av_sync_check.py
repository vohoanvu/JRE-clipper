"""A/V sync regression check for the clip renderer.

Measures, for every segment of a rendered compilation, where the segment's source audio and
source video actually landed in the output, and reports audio-minus-video in milliseconds.
A healthy render is flat (about -1 ms on every segment, occasionally +/-33 ms from frame
quantization); drift that grows with the segment number means the seams are not sample-exact.

usage (renderer local mode, from JreClipRenderer/):
  JOB_FILE=job.json SOURCE_ROOT=F:/jre-all-episodes OUTPUT_DIR=out dotnet run -c Release
  python tools/av_sync_check.py job.json out/<job>.mp4 F:/jre-all-episodes

Needs ffmpeg/ffprobe on PATH and numpy (ingestion/.venv has it).
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SR, W, H, FPS = 8000, 96, 54, 30000 / 1001
A_OFF, A_LEN, V_OFF, V_LEN = 3.0, 4.0, 3.5, 3.0  # probe windows, seconds after each segment start


def ffmpeg(args):
    return subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', *args], capture_output=True, check=True).stdout


def audio(path, start, length):
    raw = ffmpeg(['-ss', f'{start:.3f}', '-t', f'{length:.3f}', '-i', path, '-vn', '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'])
    return np.frombuffer(raw, np.int16).astype(np.float32)


def frames(path, start, length):
    raw = ffmpeg(['-ss', f'{start:.3f}', '-t', f'{length:.3f}', '-i', path, '-an',
                  '-vf', f'fps=30000/1001,scale={W}:{H},format=gray', '-f', 'rawvideo', '-'])
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)


def best_audio_offset(needle, hay):
    """Sample offset of needle inside hay with the highest normalized cross-correlation."""
    n = len(needle)
    size = 1 << int(np.ceil(np.log2(len(hay) + n)))
    corr = np.fft.irfft(np.fft.rfft(hay, size) * np.conj(np.fft.rfft(needle, size)), size)[: len(hay) - n + 1]
    energy = np.sqrt(np.convolve(hay ** 2, np.ones(n), 'valid')) * np.linalg.norm(needle) + 1e-9
    score = corr / energy
    i = int(np.argmax(score))
    return i, float(score[i])


def best_frame_offset(needle, hay):
    """Frame offset of a frame sequence inside hay with the lowest mean squared error.
    A run of frames, not a single one, because talking-head shots barely change frame to frame."""
    errors = [np.mean((hay[i:i + len(needle)] - needle) ** 2) for i in range(len(hay) - len(needle) + 1)]
    return int(np.argmin(errors))


def main(job_path, output_path, source_root):
    segments = json.load(open(job_path))['segments']
    # Most players play AAC samples back to back, so decode the output audio contiguously.
    output_audio = audio(output_path, 0, 100_000)

    def measure(k):
        seg = segments[k]
        source = f"{source_root}/{seg['videoId']}.mp4"
        start = seg['startTimeSeconds']
        nominal = sum(s['endTimeSeconds'] - s['startTimeSeconds'] for s in segments[:k])

        src_audio = audio(source, start + A_OFF, A_LEN)
        window = max(0.0, nominal + A_OFF - 2.5)
        hay = output_audio[int(window * SR): int((nominal + A_OFF + A_LEN + 2.5) * SR)]
        lag, score = best_audio_offset(src_audio - src_audio.mean(), hay - hay.mean())
        audio_start = window + lag / SR - A_OFF

        vwindow = max(0.0, audio_start + V_OFF - 1.0)
        idx = best_frame_offset(frames(source, start + V_OFF, V_LEN), frames(output_path, vwindow, V_LEN + 2.0))
        video_start = vwindow + idx / FPS - V_OFF
        return k + 1, seg['videoId'], video_start, (audio_start - video_start) * 1000, score

    with ThreadPoolExecutor(6) as pool:
        rows = list(pool.map(measure, range(len(segments))))

    print(f"{'#':>3} {'video':>11} {'out start':>9} {'A-V ms':>7} {'xcorr':>6}")
    for k, vid, video_start, offset_ms, score in rows:
        print(f"{k:>3} {vid:>11} {video_start:9.2f} {offset_ms:7.0f} {score:6.2f}")
    worst = max(abs(r[3]) for r in rows)
    print(f"worst |A-V| = {worst:.0f} ms (lip-sync is noticeable beyond ~45 ms audio-early / ~125 ms audio-late)")
    return 0 if worst <= 45 else 1


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:4]))
