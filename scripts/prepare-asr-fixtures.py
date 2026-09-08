#!/usr/bin/env python3
"""Prepare bounded English speech/reference fixtures locally; makes no API call."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--expected-md5', required=True, help='Official OpenSLR test-clean archive checksum')
args = parser.parse_args()
archive_hash = hashlib.file_digest(args.archive.open('rb'), 'md5').hexdigest()
if archive_hash != args.expected_md5:
    raise SystemExit('Archive checksum does not match the official value')
args.output.mkdir(parents=True, exist_ok=True)
manifest = {'source': 'https://www.openslr.org/12', 'dataset': 'LibriSpeech test-clean',
            'license': 'CC BY 4.0', 'attribution': 'Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur, LibriSpeech (2015)',
            'archive_md5': archive_hash, 'archive_sha256': hashlib.file_digest(args.archive.open('rb'), 'sha256').hexdigest(),
            'fixtures': []}
with tarfile.open(args.archive, 'r:gz') as tar:
    members = tar.getmembers()
    transcripts = {}
    for member in members:
        if member.isfile() and member.name.endswith('.trans.txt') and member.name.startswith('LibriSpeech/test-clean/'):
            for line in tar.extractfile(member).read().decode('utf8').splitlines():
                utterance, text = line.split(' ', 1)
                transcripts[utterance] = text
    selected, chunks, samples = [], [], 0
    audio_members = sorted((m for m in members if m.isfile() and re.fullmatch(r'LibriSpeech/test-clean/\d+/\d+/\d+-\d+-\d+\.flac', m.name)), key=lambda m: tuple(int(n) for n in Path(m.name).stem.split('-')))
    for member in audio_members:
        audio = tar.extractfile(member).read()
        if audio[:4] != b'fLaC':
            raise SystemExit('Unexpected audio format')
        packed = int.from_bytes(audio[18:26], 'big')
        count = packed & ((1 << 36) - 1)
        if packed >> 44 != 16000 or ((packed >> 41) & 7) != 0 or ((packed >> 36) & 31) != 15:
            raise SystemExit('Unexpected normalized sample format')
        if samples + count > 600 * 16000:
            break
        utterance = Path(member.name).stem
        if utterance not in transcripts:
            raise SystemExit('Missing reference text')
        decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], input=audio, capture_output=True, check=True).stdout
        if len(decoded) != count * 2:
            raise SystemExit('Decoded sample count mismatch')
        selected.append({'utterance': utterance, 'start_sample': samples, 'samples': count, 'text': transcripts[utterance],
                         'source_flac_sha256': hashlib.sha256(audio).hexdigest()})
        samples += count
        chunks.append(decoded)
    if samples < 580 * 16000:
        raise SystemExit('The selected ordered utterances do not reach the near-ten-minute target')
    for name, maximum in [('five-minute', 300), ('near-ten-minute', 600)]:
        units = [u for u in selected if u['start_sample'] + u['samples'] <= maximum * 16000]
        pcm = b''.join(chunks[:len(units)])
        flac = args.output / (name + '.flac')
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'flac', '-compression_level', '5', '-n', str(flac)], input=pcm, check=True)
        decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(flac), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], capture_output=True, check=True).stdout
        if decoded != pcm:
            raise SystemExit('Lossless PCM equality failed')
        (args.output / (name + '.txt')).write_text(' '.join(u['text'] for u in units) + '\n')
        manifest['fixtures'].append({'name': name, 'duration': len(pcm) / 32000, 'audio_bytes': flac.stat().st_size,
                                     'flac_sha256': hashlib.sha256(flac.read_bytes()).hexdigest(), 'pcm_sha256': hashlib.sha256(pcm).hexdigest(),
                                     'utterances': units})
(args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({f['name']: {'duration': f['duration'], 'bytes': f['audio_bytes'], 'utterances': len(f['utterances'])} for f in manifest['fixtures']}, indent=2))
