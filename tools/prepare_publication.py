"""Prepare a reviewed source-only tree without copying local runtime state.

The default destination is dist/public. Existing destinations are never changed.
Run --check to validate the selected source and in-memory public transformation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

ROOT = Path(__file__).absolute().parents[1]
GENERATED = {'publication-manifest.json', 'privacy-report.json'}
REVIEWED_IMAGE_PATH = 'docs/images/monitor.jpg'
MAX_REVIEWED_IMAGE_BYTES = 8 << 20
REVIEWED_VIDEO_PATH = 'docs/media/simulation.mp4'
MAX_REVIEWED_VIDEO_BYTES = 12 << 20
REVIEWED_MEDIA = {
    REVIEWED_IMAGE_PATH: ('jpeg', MAX_REVIEWED_IMAGE_BYTES),
    'docs/images/machines.jpg': ('jpeg', MAX_REVIEWED_IMAGE_BYTES),
    'docs/images/heatmap.jpg': ('jpeg', MAX_REVIEWED_IMAGE_BYTES),
    'docs/media/simulation-preview.gif': ('gif', 6 << 20),
    REVIEWED_VIDEO_PATH: ('mp4', MAX_REVIEWED_VIDEO_BYTES),
}
MEDIA_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico',
                 '.avif', '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpg', '.mpeg',
                 '.wmv', '.ogv', '.flv', '.3gp'}
FORBIDDEN_PARTS = {'.git', '.run', '.venv', '.tools', '__pycache__', '.pytest_cache',
                   'checkpoints', 'reports', 'node_modules', 'target', 'dist', 'build'}
FORBIDDEN_SUFFIXES = {'.dll', '.exe', '.so', '.dylib', '.pdb', '.pyc', '.log',
                      '.pem', '.key', '.pfx', '.p12', '.zip'} | MEDIA_SUFFIXES


class PublicationError(ValueError):
    """An unsafe or inconsistent publication input."""


def relative_name(value: str) -> str:
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise PublicationError('Manifest contains an invalid relative path')
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(p in ('', '.', '..') for p in value.split('/')):
        raise PublicationError('Manifest contains an invalid relative path')
    for part in path.parts:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part.endswith('.'):
            raise PublicationError('Manifest paths must use portable file names')
        if re.fullmatch(r'(?i)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part):
            raise PublicationError('Manifest contains a reserved file name')
    return value


def has_link(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def checked_path(root: Path, relative: str) -> Path:
    relative_name(relative)
    current = root
    for part in (None, *PurePosixPath(relative).parts):
        if part is not None:
            current /= part
        if has_link(current):
            raise PublicationError('Symbolic links and reparse points are forbidden')
    if not current.resolve().is_relative_to(root.resolve()):
        raise PublicationError('Path is outside the project root')
    return current


def approved_name(relative: str) -> None:
    relative_name(relative)
    path = PurePosixPath(relative)
    forbidden_suffix = path.suffix.lower() in FORBIDDEN_SUFFIXES and relative not in REVIEWED_MEDIA
    if {part.lower() for part in path.parts} & FORBIDDEN_PARTS or forbidden_suffix:
        raise PublicationError('Manifest includes a forbidden local artifact')
    if path.name.lower() == 'config.toml' and relative != 'native/.cargo/config.toml':
        raise PublicationError('The active runtime configuration cannot be published')
    if path.name.lower().startswith(('.env', 'secrets', 'credentials')):
        raise PublicationError('Credential files cannot be published')


def read_json(root: Path, relative: str):
    path = checked_path(root, relative)
    try:
        return json.loads(path.read_text('utf-8-sig'))
    except (OSError, ValueError) as exc:
        raise PublicationError('Cannot read required JSON file: ' + relative) from exc


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def valid_mp4(raw: bytes) -> bool:
    """Check top-level box boundaries and the required boxes of the reviewed MP4 format."""
    brands = {b'isom', b'iso2', b'iso3', b'iso4', b'iso5', b'iso6', b'mp41', b'mp42', b'avc1'}
    if len(raw) < 16 or raw[4:8] != b'ftyp' or raw[8:12] not in brands:
        return False
    ftyp_size = int.from_bytes(raw[:4], 'big')
    if not 16 <= ftyp_size <= len(raw) or ftyp_size % 4:
        return False
    offset = ftyp_size
    required = {b'moov', b'mdat'}
    while offset < len(raw):
        header = 8
        available = len(raw) - offset
        if available < header:
            return False
        size = int.from_bytes(raw[offset:offset + 4], 'big')
        kind = raw[offset + 4:offset + 8]
        if size == 1:
            header = 16
            size = int.from_bytes(raw[offset + 8:offset + header], 'big')
        elif size == 0:
            size = available
        if not header <= size <= available:
            return False
        if size > header:
            required.discard(kind)
        offset += size
    return not required


def reviewed_media_issue(name: str, raw: bytes, policy: dict) -> str | None:
    """A review authorizes exact file bytes, format and path together."""
    kind, limit = REVIEWED_MEDIA[name]
    assets = policy.get('reviewed_binary_assets', {})
    record = assets.get(name) if isinstance(assets, dict) else None
    if (not isinstance(record, dict)
            or record.get('kind') != kind or not isinstance(record.get('review'), str)
            or not record['review'].strip()
            or not re.fullmatch(r'[0-9a-f]{64}', str(record.get('sha256', '')))):
        return 'unreviewed_binary_asset'
    if len(raw) > limit:
        return 'invalid_reviewed_' + kind
    if kind == 'jpeg' and (len(raw) < 5 or not raw.startswith(b'\xff\xd8\xff') or not raw.endswith(b'\xff\xd9')):
        return 'invalid_reviewed_jpeg'
    if kind == 'gif' and (len(raw) < 14 or raw[:6] not in (b'GIF87a', b'GIF89a')
                          or raw[6:8] == b'\0\0' or raw[8:10] == b'\0\0' or raw[-1:] != b';'):
        return 'invalid_reviewed_gif'
    if kind == 'mp4' and not valid_mp4(raw):
        return 'invalid_reviewed_mp4'
    if hashlib.sha256(raw).hexdigest() != record['sha256']:
        return 'reviewed_asset_hash_mismatch'
    return None


def extract_json_script(raw: bytes, marker: str):
    text = raw.decode('utf-8-sig')
    if marker not in text:
        raise PublicationError('Generated catalog script has an unexpected format')
    prefix, remainder = text.split(marker, 1)
    value, length = json.JSONDecoder().raw_decode(remainder.lstrip())
    suffix = remainder.lstrip()[length:]
    return prefix + marker, value, suffix


def filter_script(raw: bytes, marker: str, allowed: set[str]) -> bytes:
    prefix, entries, suffix = extract_json_script(raw, marker)
    if not isinstance(entries, list):
        raise PublicationError('Catalog script must contain an array')
    selected = [entry for entry in entries if entry['id'] in allowed]
    return (prefix + json.dumps(selected, ensure_ascii=False, separators=(',', ':')) + suffix).encode('utf-8')


def public_payload(files: dict[str, bytes], policy: dict) -> dict[str, bytes]:
    """Filter data records only; cell coordinates of retained patterns stay exact."""
    output = dict(files)
    allowed = set(policy['allowed_pattern_ids'])
    entries = json.loads(files['web/patterns.json'])
    selected = [entry for entry in entries if entry['id'] in allowed]
    if len(selected) != policy['public_catalog_count'] or {p['id'] for p in selected} != allowed:
        raise PublicationError('Public catalog IDs or count differ from the reviewed policy')
    output['web/patterns.json'] = (json.dumps(selected, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    output['web/patterns.js'] = filter_script(files['web/patterns.js'], 'window.LIFE_PATTERNS = ', allowed)
    output['web/patterns.js'] = output['web/patterns.js'].replace(
        b'Existing digital clock and original logic demos', b'Original logic demos', 1)
    output['web/device-library.js'] = filter_script(files['web/device-library.js'], 'window.LIFE_PATTERNS.push(...', allowed)
    source_catalog = json.loads(files['examples/devices/catalog.json'])
    output['examples/devices/catalog.json'] = json_bytes([entry for entry in source_catalog if entry['id'] in allowed])
    prefix, locales, suffix = extract_json_script(files['web/catalog-locales.js'], 'return ')
    for locale in locales.values():
        locale['patterns'] = {key: value for key, value in locale['patterns'].items() if key in allowed}
        if set(locale['patterns']) != allowed:
            raise PublicationError('Catalog translation IDs differ from the reviewed policy')
    output['web/catalog-locales.js'] = (prefix + json.dumps(locales, ensure_ascii=False, indent=2) + suffix).encode('utf-8')
    html = files['web/index.html'].decode('utf-8-sig')
    output['web/index.html'] = re.sub(r'[ \t]*<script\s+src=["\']clock-pattern\.js(?:\?[^"\']*)?["\']\s*>\s*</script>\r?\n?', '', html).encode('utf-8')
    for name in ('devices-validation.json', 'fast-machines-validation.json'):
        key = 'tests/fixtures/' + name
        source = json.loads(files[key])
        # Only public device evidence is needed by the release's native tests.
        result = {'rule': source['rule'], 'devices': [entry for entry in source['devices'] if entry['id'] in allowed]}
        for field in ('coordinate_hash_format', 'reference_engine'):
            if field in source:
                result[field] = source[field]
        output[key] = json_bytes(result)
    output['publication-profile.json'] = json_bytes({
        'version': 1, 'profile': 'public', 'catalog_count': policy['public_catalog_count'],
        'fast_machine_count': 2, 'clock_included': False,
    })
    validate_catalog(output, allowed)
    return output


def validate_catalog(files: dict[str, bytes], allowed: set[str]) -> None:
    _, base, _ = extract_json_script(files['web/patterns.js'], 'window.LIFE_PATTERNS = ')
    _, additions, _ = extract_json_script(files['web/device-library.js'], 'window.LIFE_PATTERNS.push(...')
    entries = json.loads(files['web/patterns.json'])
    if base + additions != entries:
        raise PublicationError('The browser and API catalogs are inconsistent')
    permitted_assets = set()
    for entry in entries:
        if entry.get('asset'):
            stem = 'web/patterns/' + entry['asset']
            permitted_assets.update((stem + '.rle', stem + '.js'))
            for name in (stem + '.rle', stem + '.js'):
                if name not in files:
                    raise PublicationError('A public pattern asset is missing: ' + name)
            if entry.get('sha256') != hashlib.sha256(files[stem + '.rle']).hexdigest():
                raise PublicationError('A public pattern asset hash differs from its catalog')
    if {name for name in files if name.startswith('web/patterns/')} != permitted_assets:
        raise PublicationError('An unlisted pattern asset would be published')
    html = files['web/index.html'].decode('utf-8-sig')
    for script in re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)', html):
        name = 'web/' + script.split('?', 1)[0]
        if name not in files:
            raise PublicationError('A page script is missing from the allowlist: ' + name)
    if 'web/clock-pattern.js' in files or 'clock' in allowed:
        raise PublicationError('An unapproved clock asset would be published')


def privacy_findings(files: dict[str, bytes], policy: dict) -> list[dict]:
    """Return locations and categories only; never include matched secret values."""
    patterns = {
        'user_profile_path': r'(?i)(?:\b[A-Z]:[\\/]+Users[\\/]+[^\s"\'<>]+|\/home\/[^/\s]+|\/Users\/[^/\s]+)',
        'private_installation_path': r'(?i)\b[A-Z]:[\\/](?:apps|ProgramData|Temp)[\\/]',
        'private_key': r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
        'credential_token': r'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b',
        'url_credentials': r'\b[a-z]+://[^\s/:]+:[^\s/@]+@',
        'credential_literal': r'''(?i)["']?(?:access[_-]?token|api[_-]?key|password|secret)["']?\s*[:=]\s*["'][^"'\r\n]{4,}["']''',
        'private_ipv4': r'(?<![\w.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\w.])',
    }
    for key in ('USERNAME', 'USER', 'COMPUTERNAME'):
        value = os.environ.get(key, '')
        if len(value) >= 4 and value.lower() not in ('root', 'user', 'admin', 'runner', 'localhost'):
            patterns['local_' + key.lower()] = r'(?i)(?<![\w-])' + re.escape(value) + r'(?![\w-])'
    email = re.compile(r'(?<![\w.-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])')
    allowed_emails = {value.lower() for value in policy['allowed_public_emails']}
    compiled = [(category, re.compile(pattern)) for category, pattern in patterns.items()]
    findings = []
    for name, raw in sorted(files.items()):
        if name in REVIEWED_MEDIA:
            issue = reviewed_media_issue(name, raw, policy)
            if issue:
                findings.append({'path': name, 'category': issue, 'line': 0})
            continue
        if PurePosixPath(name).suffix.lower() in MEDIA_SUFFIXES:
            findings.append({'path': name, 'category': 'unexpected_binary', 'line': 0})
            continue
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            findings.append({'path': name, 'category': 'unexpected_binary', 'line': 0})
            continue
        for category, pattern in compiled:
            for match in pattern.finditer(text):
                findings.append({'path': name, 'category': category, 'line': text.count('\n', 0, match.start()) + 1})
        for match in email.finditer(text):
            if match.group().lower() not in allowed_emails:
                findings.append({'path': name, 'category': 'unapproved_email', 'line': text.count('\n', 0, match.start()) + 1})
    return findings


def public_inventory(root: Path, approved: set[str]) -> dict[str, bytes]:
    """Reject additions that bypass review in an exported source checkout."""
    runtime_dirs = {'.git', '.run', '.venv', '.tools', '.pytest_cache', 'checkpoints',
                    'node_modules', 'native/target', 'dist', 'build', 'htmlcov', 'test-results'}
    generated = {}
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs
                   if (Path(folder) / name).relative_to(root).as_posix() not in runtime_dirs
                   and name != '__pycache__' and not name.endswith('.egg-info')]
        for name in dirs:
            if has_link(Path(folder) / name):
                raise PublicationError('Public source contains a linked directory')
        for name in names:
            path = Path(folder) / name
            relative = path.relative_to(root).as_posix()
            if relative in ('.git', 'config.toml', '.coverage', '.DS_Store') or path.suffix == '.pyc':
                continue
            if has_link(path):
                raise PublicationError('Public source contains a linked file')
            if relative not in approved and relative not in GENERATED:
                raise PublicationError('Public source has an unreviewed file: ' + relative)
            if relative in GENERATED:
                generated[relative] = path.read_bytes()
    return generated


def load_payload(root: Path):
    manifest = read_json(root, 'publication-files.json')
    policy = read_json(root, 'publication-policy.json')
    profile = read_json(root, 'publication-profile.json')
    if manifest.get('version') != 1 or policy.get('version') != 1 or profile.get('profile') not in ('full', 'public'):
        raise PublicationError('Unknown publication manifest version or profile')
    names = manifest.get('files')
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise PublicationError('File allowlist must contain relative path strings')
    if len(names) != len({name.lower() for name in names}):
        raise PublicationError('File allowlist must contain unique relative paths')
    generated = public_inventory(root, set(names)) if profile['profile'] == 'public' else {}
    files = {}
    for name in names:
        approved_name(name)
        path = checked_path(root, name)
        if not path.is_file():
            raise PublicationError('An allowlisted file is missing: ' + name)
        if name in REVIEWED_MEDIA and path.stat().st_size > REVIEWED_MEDIA[name][1]:
            raise PublicationError('Reviewed media exceeds its size limit: ' + name)
        raw = path.read_bytes()
        # Match Git's LF checkout policy before hashing the public source.
        # RLE and reviewed media retain their exact bytes and checksums.
        files[name] = raw if name.endswith('.rle') or name in REVIEWED_MEDIA else raw.replace(b'\r\n', b'\n')
    findings = privacy_findings({**files, **generated}, policy)
    public = public_payload(files, policy)
    findings += privacy_findings(public, policy)
    # Stable deduplication keeps source/copy findings concise without secret text.
    findings = list({(f['path'], f['category'], f['line']): f for f in findings}.values())
    if findings:
        return public, {'version': 1, 'profile': 'public', 'scanned_files': len(files), 'findings': findings}
    return public, {'version': 1, 'profile': 'public', 'scanned_files': len(files), 'findings': []}


def write_fresh(root: Path, destination: str, files: dict[str, bytes], audit: dict) -> Path:
    relative_name(destination)
    if not destination.startswith('dist/'):
        raise PublicationError('Publication output must be beneath dist/')
    target = checked_path(root, destination)
    if os.path.lexists(target):
        raise PublicationError('Destination already exists; choose a new directory')
    if audit['findings']:
        raise PublicationError('Privacy findings must be resolved before export')
    payload = dict(files)
    reviewed_names = payload.keys() & REVIEWED_MEDIA.keys()
    if reviewed_names:
        policy = json.loads(payload.get('publication-policy.json', b'{}'))
        for name in sorted(reviewed_names):
            issue = reviewed_media_issue(name, payload[name], policy)
            if issue:
                raise PublicationError('Reviewed media validation failed: ' + name + ' (' + issue + ')')
    payload['privacy-report.json'] = json_bytes(audit)
    manifest = {'version': 1, 'algorithm': 'sha256', 'profile': 'public',
                'excludes': ['publication-manifest.json'], 'files': []}
    for name, raw in sorted(payload.items()):
        approved_name(name)
        manifest['files'].append({'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    payload['publication-manifest.json'] = json_bytes(manifest)
    target.mkdir(parents=True, exist_ok=False)
    for name, raw in sorted(payload.items()):
        path = checked_path(target, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(raw)
    return target


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Audit without writing a publication tree')
    parser.add_argument('--output', default='dist/public', help='Fresh directory beneath dist/')
    args = parser.parse_args(argv)
    try:
        payload, report = load_payload(ROOT)
        print(json.dumps(report, ensure_ascii=True, indent=2))
        if report['findings']:
            return 1
        if not args.check:
            target = write_fresh(ROOT, args.output, payload, report)
            print('Prepared ' + target.relative_to(ROOT).as_posix())
        return 0
    except (PublicationError, OSError, UnicodeError, KeyError, json.JSONDecodeError) as exc:
        # OS exceptions can contain absolute paths; report only a safe category.
        detail = str(exc) if isinstance(exc, PublicationError) else type(exc).__name__
        print('Publication failed: ' + detail, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
