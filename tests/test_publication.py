"""Publication isolation, profile, privacy, and file-safety regressions."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_publication', ROOT / 'tools/prepare_publication.py')
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


@pytest.mark.parametrize('name', [
    '../outside.txt', '/absolute.txt', 'nested/../escape', 'nested//file',
    'C:' + '/absolute.txt', 'config.toml', '.run/state.json', 'reports/image.jpg',
    'native/target/release/core.dll', '.git/config', '.env', 'secrets.json',
    '.Git/config', 'Config.toml', '.run./data', 'NUL', 'nested/file\nname',
    'docs/media/another.mp4', 'docs/media/Simulation.mp4', 'docs/media/simulation.webm',
    'docs/media/another.gif', 'docs/images/catalog.jpg',
])
def test_manifest_cannot_include_private_or_escaping_paths(name):
    with pytest.raises(publication.PublicationError):
        publication.approved_name(name)


def test_scan_reports_locations_without_disclosing_values():
    policy = {'allowed_public_emails': ['contact' + '@' + 'example.org']}
    samples = {
        'token.txt': ('ghp_' + 'Q' * 36).encode(),
        'key.txt': ('-----BEGIN ' + 'PRIVATE KEY-----').encode(),
        'path.txt': ('C:/' + 'Users' + '/PrivatePerson/data.txt').encode(),
        'email.txt': ('someone' + '@' + 'private.example').encode(),
        'contact.txt': ('contact' + '@' + 'example.org').encode(),
    }
    findings = publication.privacy_findings(samples, policy)
    assert {entry['path'] for entry in findings} == set(samples) - {'contact.txt'}
    serialized = json.dumps(findings)
    assert all(raw.decode() not in serialized for raw in samples.values())
    assert all(set(entry) == {'path', 'category', 'line'} for entry in findings)


def jpeg_fixture():
    return (ROOT / publication.REVIEWED_IMAGE_PATH).read_bytes()

def media_policy(raw, name=publication.REVIEWED_IMAGE_PATH, kind='jpeg'):
    return {'version': 1, 'allowed_public_emails': [], 'reviewed_binary_assets': {
        name: {
            'sha256': hashlib.sha256(raw).hexdigest(), 'kind': kind,
            'review': 'Reviewed synthetic test fixture.',
        }}}


def test_only_the_exact_reviewed_jpeg_is_accepted(tmp_path):
    raw = jpeg_fixture()
    name = publication.REVIEWED_IMAGE_PATH
    policy = media_policy(raw)
    publication.approved_name(name)
    assert publication.privacy_findings({name: raw}, policy) == []
    with pytest.raises(publication.PublicationError):
        publication.approved_name('docs/images/another.png')
    with pytest.raises(publication.PublicationError):
        publication.approved_name('docs/images/Monitor.jpg')
    assert publication.privacy_findings({'docs/images/another.png': raw}, policy)[0]['category'] == 'unexpected_binary'
    assert publication.privacy_findings({name: raw}, {'allowed_public_emails': []})[0]['category'] == 'unreviewed_binary_asset'
    offset = len(raw) // 2
    changed = raw[:offset] + bytes([raw[offset] ^ 1]) + raw[offset + 1:]
    assert publication.privacy_findings({name: changed}, policy)[0]['category'] == 'reviewed_asset_hash_mismatch'
    # The final write repeats validation even if the caller supplies a clean report.
    with pytest.raises(publication.PublicationError, match='hash_mismatch'):
        publication.write_fresh(tmp_path, 'dist/rejected', {
            name: changed, 'publication-policy.json': publication.json_bytes(policy)}, {'findings': []})
    assert not (tmp_path / 'dist').exists()
    target = publication.write_fresh(tmp_path, 'dist/accepted', {
        name: raw, 'publication-policy.json': publication.json_bytes(policy)}, {'findings': []})
    assert (target / name).read_bytes() == raw


@pytest.mark.parametrize('invalid', [
    b'not a JPEG', b'\x89PNG\r\n\x1a\n' + bytes(40),
    b'\xff\xd8\xff\xe0' + bytes(40), b'wrong signature\xff\xd9',
])
def test_reviewed_image_requires_jpeg_signature_and_end_marker(invalid):
    findings = publication.privacy_findings({publication.REVIEWED_IMAGE_PATH: invalid}, media_policy(invalid))
    assert findings[0]['category'] == 'invalid_reviewed_jpeg'


def test_reviewed_image_size_is_bounded():
    oversized = jpeg_fixture()[:-2] + bytes(publication.MAX_REVIEWED_IMAGE_BYTES) + b'\xff\xd9'
    findings = publication.privacy_findings({publication.REVIEWED_IMAGE_PATH: oversized}, media_policy(oversized))
    assert findings[0]['category'] == 'invalid_reviewed_jpeg'


def box(kind, payload):
    return (8 + len(payload)).to_bytes(4, 'big') + kind + payload


def mp4_fixture():
    # Only the ISO BMFF container is needed to exercise the publication checks.
    return (box(b'ftyp', b'isom\0\0\0\x01mp42') + box(b'moov', box(b'mvhd', bytes(100)))
            + box(b'mdat', b'frame\r\nbytes'))


def gif_fixture():
    header = b'GIF89a\x01\0\x01\0\x80\0\0' + bytes(3) + b'\xff' * 3
    image = b',\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0'
    return header + b'!\xfe\x02\r\n\0' + image * 2 + b';'


def test_video_requires_exact_approved_path_kind_review_and_hash(tmp_path):
    raw = mp4_fixture()
    name = publication.REVIEWED_VIDEO_PATH
    policy = media_policy(raw, name, 'mp4')
    publication.approved_name(name)
    assert publication.privacy_findings({name: raw}, policy) == []
    other_name = 'docs/media/another.mp4'
    assert publication.privacy_findings({other_name: raw}, media_policy(raw, other_name, 'mp4')) == [
        {'path': other_name, 'category': 'unexpected_binary', 'line': 0}]
    for unapproved in ({'allowed_public_emails': []}, media_policy(raw, name, 'jpeg')):
        assert publication.privacy_findings({name: raw}, unapproved)[0]['category'] == 'unreviewed_binary_asset'
    no_review = media_policy(raw, name, 'mp4')
    no_review['reviewed_binary_assets'][name]['review'] = ' '
    assert publication.privacy_findings({name: raw}, no_review)[0]['category'] == 'unreviewed_binary_asset'
    changed = raw[:-1] + b'!'
    assert publication.privacy_findings({name: changed}, policy)[0]['category'] == 'reviewed_asset_hash_mismatch'
    with pytest.raises(publication.PublicationError, match='hash_mismatch'):
        publication.write_fresh(tmp_path, 'dist/unapproved', {
            name: changed, 'publication-policy.json': publication.json_bytes(policy)}, {'findings': []})
    assert not (tmp_path / 'dist').exists()


@pytest.mark.parametrize('invalid', [
    b'not an MP4', box(b'ftyp', b'isom\0\0\0\0'),
    mp4_fixture().replace(b'isom', b'avif'), mp4_fixture().replace(b'moov', b'free'),
    mp4_fixture()[:-1], mp4_fixture() + b'bad', mp4_fixture() + b'\0\0\0\x01free',
])
def test_reviewed_video_requires_expected_mp4_boxes(invalid):
    name = publication.REVIEWED_VIDEO_PATH
    assert publication.privacy_findings({name: invalid}, media_policy(invalid, name, 'mp4'))[0]['category'] == 'invalid_reviewed_mp4'


def test_reviewed_video_size_is_bounded():
    name = publication.REVIEWED_VIDEO_PATH
    raw = mp4_fixture() + box(b'free', bytes(publication.MAX_REVIEWED_VIDEO_BYTES))
    assert publication.privacy_findings({name: raw}, media_policy(raw, name, 'mp4'))[0]['category'] == 'invalid_reviewed_mp4'


def test_reviewed_preview_requires_gif_signature_dimensions_trailer_size_and_hash():
    name = 'docs/media/simulation-preview.gif'
    raw = gif_fixture()
    policy = media_policy(raw, name, 'gif')
    for invalid in (b'not a GIF', b'GIF99a' + raw[6:], raw[:6] + bytes(2) + raw[8:],
                    raw[:-1], raw[:-1] + bytes(6 << 20) + b';'):
        issues = publication.privacy_findings({name: invalid}, media_policy(invalid, name, 'gif'))
        assert issues[0]['category'] == 'invalid_reviewed_gif'
    changed = raw.replace(b'\r\n', b'AB')
    assert publication.privacy_findings({name: changed}, policy)[0]['category'] == 'reviewed_asset_hash_mismatch'
    other_path = 'docs/media/private.gif'
    assert publication.privacy_findings({other_path: raw}, media_policy(raw, other_path, 'gif'))[0]['category'] == 'unexpected_binary'


@pytest.mark.parametrize(('name', 'kind'), [
    (publication.REVIEWED_IMAGE_PATH, 'jpeg'), ('docs/images/machines.jpg', 'jpeg'),
    ('docs/images/heatmap.jpg', 'jpeg'), ('docs/media/simulation-preview.gif', 'gif'),
    (publication.REVIEWED_VIDEO_PATH, 'mp4'),
])
def test_reviewed_media_bytes_survive_source_normalization_and_export(tmp_path, monkeypatch, name, kind):
    if kind == 'jpeg':
        original = jpeg_fixture()
        # An anonymous two-byte JPEG comment ensures this fixture contains CRLF.
        raw = original[:2] + b'\xff\xfe\x00\x04\r\n' + original[2:]
    elif kind == 'gif':
        raw = gif_fixture()
    else:
        raw = mp4_fixture()
    (tmp_path / name).parent.mkdir(parents=True)
    (tmp_path / name).write_bytes(raw)
    (tmp_path / 'README.md').write_bytes(b'Public text\r\n')
    (tmp_path / 'publication-files.json').write_bytes(publication.json_bytes({
        'version': 1, 'files': [name, 'README.md', 'publication-policy.json']}))
    (tmp_path / 'publication-policy.json').write_bytes(publication.json_bytes(media_policy(raw, name, kind)))
    (tmp_path / 'publication-profile.json').write_bytes(publication.json_bytes({'version': 1, 'profile': 'full'}))
    monkeypatch.setattr(publication, 'public_payload', lambda files, policy: files)
    files, report = publication.load_payload(tmp_path)
    assert report['findings'] == []
    assert files[name] == raw
    assert files['README.md'] == b'Public text\n'
    target = publication.write_fresh(tmp_path, 'dist/public', files, report)
    assert (target / name).read_bytes() == raw
    manifest = json.loads((target / 'publication-manifest.json').read_bytes())
    record = next(entry for entry in manifest['files'] if entry['path'] == name)
    assert record == {'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def test_symlink_source_and_destination_are_rejected(tmp_path):
    outside = tmp_path / 'outside'
    outside.mkdir()
    link = tmp_path / 'linked'
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip('This account cannot create symbolic links')
    with pytest.raises(publication.PublicationError, match='links'):
        publication.checked_path(tmp_path, 'linked/example.txt')
    (tmp_path / 'dist').mkdir()
    (tmp_path / 'dist' / 'redirect').symlink_to(outside, target_is_directory=True)
    with pytest.raises(publication.PublicationError, match='links'):
        publication.write_fresh(tmp_path, 'dist/redirect/public', {}, {'findings': []})
    assert not list(outside.iterdir())


def test_export_never_overwrites_and_manifest_contains_relative_hashes(tmp_path):
    payload = {'README.md': b'Public source\n'}
    report = {'version': 1, 'profile': 'public', 'scanned_files': 1, 'findings': []}
    target = publication.write_fresh(tmp_path, 'dist/public', payload, report)
    manifest = json.loads((target / 'publication-manifest.json').read_text())
    for entry in manifest['files']:
        assert not Path(entry['path']).is_absolute()
        raw = (target / entry['path']).read_bytes()
        assert entry['sha256'] == hashlib.sha256(raw).hexdigest()
        assert entry['bytes'] == len(raw)
    with pytest.raises(publication.PublicationError, match='already exists'):
        publication.write_fresh(tmp_path, 'dist/public', {'README.md': b'Changed'}, report)
    assert (target / 'README.md').read_bytes() == payload['README.md']
    with pytest.raises(publication.PublicationError):
        publication.write_fresh(tmp_path, '../unsafe', payload, report)
    with pytest.raises(publication.PublicationError):
        publication.write_fresh(tmp_path, 'public', payload, report)


def test_export_validates_all_inputs_before_creating_any_directory(tmp_path):
    with pytest.raises(publication.PublicationError):
        publication.write_fresh(tmp_path, 'dist/public', {'../escape': b'data'}, {'findings': []})
    assert not (tmp_path / 'dist').exists()
    with pytest.raises(publication.PublicationError):
        publication.write_fresh(tmp_path, 'dist/public', {}, {'findings': [{'category': 'test'}]})
    assert not (tmp_path / 'dist').exists()


def test_public_checkout_rejects_unreviewed_files_and_scans_generated_reports(tmp_path):
    (tmp_path / 'README.md').write_text('Public source', encoding='utf-8')
    (tmp_path / '.run').mkdir()
    (tmp_path / '.run' / 'runtime.json').write_text('{}', encoding='utf-8')
    (tmp_path / 'privacy-report.json').write_text('{}', encoding='utf-8')
    generated = publication.public_inventory(tmp_path, {'README.md'})
    assert set(generated) == {'privacy-report.json'}
    extra = tmp_path / 'unreviewed.txt'
    extra.write_text('Must receive review', encoding='utf-8')
    with pytest.raises(publication.PublicationError, match='unreviewed file'):
        publication.public_inventory(tmp_path, {'README.md'})


def test_public_data_filters_every_catalog_and_preserves_source_cells(tmp_path):
    before = (ROOT / 'web/patterns.json').read_bytes()
    files, audit = publication.load_payload(ROOT)
    assert audit['findings'] == []
    source = {p['id']: p for p in json.loads(before)}
    entries = json.loads(files['web/patterns.json'])
    policy = json.loads(files['publication-policy.json'])
    assert len(entries) == 59
    assert {p['id'] for p in entries} == set(policy['allowed_pattern_ids'])
    assert all(p == source[p['id']] for p in entries)
    assert (ROOT / 'web/patterns.json').read_bytes() == before
    assert set(policy['excluded_pattern_ids']).isdisjoint(p['id'] for p in entries)
    assert len(json.loads(files['examples/devices/catalog.json'])) == 2
    assert len(json.loads(files['tests/fixtures/devices-validation.json'])['devices']) == 0
    assert len(json.loads(files['tests/fixtures/fast-machines-validation.json'])['devices']) == 2
    assert 'measured_seconds' not in files['tests/fixtures/fast-machines-validation.json'].decode()
    assert 'benchmark' not in files['tests/fixtures/fast-machines-validation.json'].decode()
    assert 'clock-pattern.js' not in files['web/index.html'].decode()
    assert set(p for p in files if p.startswith('web/patterns/')) == {
        'web/patterns/' + stem + ext
        for stem in ('blinker-puffer', 'block-laying-switch-engine') for ext in ('.rle', '.js')}
    _, locales, _ = publication.extract_json_script(files['web/catalog-locales.js'], 'return ')
    for locale in locales.values():
        assert set(locale['patterns']) == set(policy['allowed_pattern_ids'])
    assert json.loads(files['publication-profile.json'])['profile'] == 'public'
    target = publication.write_fresh(tmp_path, 'dist/public', files, audit)
    assert not (target / '.git').exists()
    assert not (target / 'config.toml').exists()
    assert not (target / 'examples/devices/verify-macro.cjs').exists()
    assert not (target / 'web/clock-pattern.js').exists()
    _, rechecked = publication.load_payload(target)
    assert rechecked['findings'] == []
    # Rebuild generated data from published sources to prove the filter is durable.
    expected = json.loads((target / 'web/patterns.json').read_text('utf-8'))
    subprocess.run([sys.executable, 'examples/devices/build_catalog.py'], cwd=target, check=True,
                   capture_output=True, text=True)
    assert json.loads((target / 'web/patterns.json').read_text('utf-8')) == expected
