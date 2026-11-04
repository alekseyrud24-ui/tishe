"""Real public relay/audio check; keeps generated test recordings in Hermes scratch."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

BASE = 'https://tishe-voice.aleksey-rud24.workers.dev'
DEST = Path(os.environ['LOCALAPPDATA']) / 'hermes/cache/scratch/tishe-worker-probes'
DEST.mkdir(parents=True, exist_ok=True)
results = []
for voice in ['ru-RU-DmitryNeural', 'ru-RU-SvetlanaNeural']:
    for route in ['bing', 'edge']:
        name = voice.split('-')[-1] + '-' + route
        path = DEST / (name + '.mp3')
        headers = DEST / (name + '.headers')
        data = json.dumps({'voice': voice, 'text': 'Проверка читалки Тише. Голос читает полное предложение через собственный облачный мост.', 'rate': 0.95, 'pitch': 1, 'route': route}, ensure_ascii=False).encode()
        start = time.monotonic()
        command = ['curl', '-sS', '--max-time', '75', '-D', str(headers), '-o', str(path), '-w', '%{http_code}', '-H', 'Content-Type: application/json', '-H', 'Origin: https://alekseyrud24-ui.github.io', '--data-binary', '@-', BASE + '/api/tts']
        r = subprocess.run(command, input=data, capture_output=True, check=True)
        record = {'voice': voice, 'route': route, 'http': r.stdout.decode(), 'seconds': round(time.monotonic() - start, 2), 'bytes': path.stat().st_size}
        if record['http'] != '200':
            record['error'] = path.read_text(encoding='utf-8', errors='replace')[:500]
        else:
            h = headers.read_text(encoding='utf-8').lower()
            assert 'x-tishe-complete: 1' in h and 'x-tishe-voice: ' + voice.lower() in h
            info = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', str(path)], capture_output=True, check=True)
            record['audio'] = json.loads(info.stdout)
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'null', '-'], capture_output=True, check=True)
            record['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            # A repeat must be the exact same complete audio, now served from edge cache.
            second = subprocess.run(command, input=data, capture_output=True, check=True)
            assert second.stdout == b'200'
            assert hashlib.sha256(path.read_bytes()).hexdigest() == record['sha256']
            record['repeat_cache'] = 'x-tishe-cache: hit' in headers.read_text(encoding='utf-8').lower()
            assert record['repeat_cache']
        results.append(record)
        print(json.dumps(record, ensure_ascii=False), flush=True)
(DEST / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
assert all(item['http'] == '200' for item in results), 'One or more live Microsoft routes failed'