#!/usr/bin/env python3
"""Génère docs/TRACEABILITY.md et la section « ambiguïtés analysées » de docs/DECISIONS.md
à partir de l'analyse structurée du CDC (docs/traceability/requirements.json, ambiguities.json)
et de l'état d'avancement maintenu à la main (docs/traceability/status.json).

Usage : python3 scripts/docs/build-traceability.py [--import-journal <journal.jsonl>]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs' / 'traceability'
DATA.mkdir(parents=True, exist_ok=True)

TESTS = {f'T{n:02d}' for n in range(1, 45)}


def import_journal(path: Path) -> None:
    reqs, ambs = [], []
    for line in path.read_text().splitlines():
        try:
            j = json.loads(line)
        except json.JSONDecodeError:
            continue
        if j.get('type') != 'result' or not isinstance(j.get('result'), dict):
            continue
        r = j['result']
        reqs.extend(r.get('requirements', []))
        ambs.extend(r.get('ambiguities', []))
    # dédoublonnage par id (les ids du critique sont préfixés X)
    seen = {}
    for r in reqs:
        seen.setdefault(r['id'], r)
    (DATA / 'requirements.json').write_text(json.dumps(list(seen.values()), ensure_ascii=False, indent=1))
    (DATA / 'ambiguities.json').write_text(json.dumps(ambs, ensure_ascii=False, indent=1))
    print(f'{len(seen)} exigences et {len(ambs)} ambiguïtés importées')


def section_key(section: str):
    parts = re.findall(r'\d+', section)
    return tuple(int(p) for p in parts) if parts else (999,)


def build() -> None:
    reqs = json.loads((DATA / 'requirements.json').read_text())
    ambs = json.loads((DATA / 'ambiguities.json').read_text()) if (DATA / 'ambiguities.json').exists() else []
    status_path = DATA / 'status.json'
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    reqs.sort(key=lambda r: (section_key(r['section']), r['id']))

    covered_tests = {}
    for r in reqs:
        for t in r.get('tests', []):
            covered_tests.setdefault(t, []).append(r['id'])

    lines = [
        '# Traçabilité des exigences',
        '',
        'Une ligne par exigence atomique du cahier des charges v1.1 (`docs/cahier-des-charges-v1.1.md`), reliée au module, au lot, aux fichiers qui la réalisent et au test qui la prouve. '
        'Généré par `scripts/docs/build-traceability.py` à partir de `docs/traceability/requirements.json` (analyse du CDC) et `docs/traceability/status.json` (état réel, mis à jour à chaque lot). '
        'Statuts : **fait** (implémenté et test vert), **partiel**, **à faire**, **non testé** (implémenté sans test automatisé), **hors périmètre** (dépendance externe ou décision documentée).',
        '',
        '## Synthèse',
        '',
    ]
    counts = {}
    for r in reqs:
        st = status.get(r['id'], {}).get('status', 'à faire')
        counts[st] = counts.get(st, 0) + 1
    lines.append('| Statut | Nombre |')
    lines.append('| --- | --- |')
    for st in ['fait', 'partiel', 'non testé', 'à faire', 'hors périmètre']:
        lines.append(f'| {st} | {counts.get(st, 0)} |')
    lines.append(f'| **total** | **{len(reqs)}** |')
    lines.append('')

    lines += ['## Tests de recette T01 à T44', '', '| Test | Exigences portées | Fichier de test | Statut |', '| --- | --- | --- | --- |']
    test_status = status.get('__tests__', {})
    for t in sorted(TESTS):
        ids = covered_tests.get(t, [])
        ts = test_status.get(t, {})
        lines.append(f"| {t} | {', '.join(ids) if ids else '—'} | {ts.get('file', '—')} | {ts.get('status', 'à faire')} |")
    lines.append('')

    current = None
    lines += ['## Exigences', '']
    for r in reqs:
        sec = r['section']
        if sec != current:
            current = sec
            lines += ['', f'### Section {sec}', '', '| ID | Exigence | Module | Lot | Fichiers | Tests | Vérif. | Statut |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
        st = status.get(r['id'], {})
        files = st.get('files') or r.get('plannedFiles') or []
        tests = st.get('tests') or r.get('tests') or []
        rule = r['rule'].replace('|', '\\|').replace('\n', ' ')
        title = r['title'].replace('|', '\\|')
        lines.append(
            f"| {r['id']} | **{title}** — {rule} | {r['module']} | {r['lot']} | {'<br>'.join(f'`{f}`' for f in files)} | {', '.join(tests) if tests else '—'} | {st.get('verification', r.get('verification', ''))} | {st.get('status', 'à faire')} |"
        )
    (ROOT / 'docs' / 'TRACEABILITY.md').write_text('\n'.join(lines) + '\n')

    # Section des ambiguïtés dans DECISIONS.md (bloc régénéré entre marqueurs)
    dec_path = ROOT / 'docs' / 'DECISIONS.md'
    dec = dec_path.read_text() if dec_path.exists() else '# Décisions et ambiguïtés tranchées\n'
    start, end = '<!-- AMBIGUITES:DEBUT -->', '<!-- AMBIGUITES:FIN -->'
    block = [start, '', '## Ambiguïtés relevées à l\'analyse du CDC', '',
             'Liste issue de l\'analyse systématique du cahier des charges (huit lectures parallèles puis critique de complétude). '
             'Chaque entrée indique l\'option retenue ; les entrées **irréversible** ou **contradiction-cdc** sont signalées au client avant toute mise en production des données concernées.', '']
    ambs.sort(key=lambda a: (section_key(a['section']), a['topic']))
    for i, a in enumerate(ambs, start=100):
        sev = a.get('severity', 'non-bloquant')
        flag = f' — **{sev}**' if sev != 'non-bloquant' else ''
        block += [f"### D-{i} — [{a['section']}] {a['topic']}{flag}", '',
                  f"- **Ambiguïté** : {a['ambiguity']}",
                  f"- **Options** : {' / '.join(a.get('options', []))}",
                  f"- **Décision** : {a['recommendedDecision']}",
                  f"- **Justification** : {a['rationale']}", '']
    block.append(end)
    if start in dec and end in dec:
        dec = dec[: dec.index(start)] + '\n'.join(block) + dec[dec.index(end) + len(end):]
    else:
        dec = dec.rstrip('\n') + '\n\n' + '\n'.join(block) + '\n'
    dec_path.write_text(dec)
    print(f'TRACEABILITY.md : {len(reqs)} exigences ; DECISIONS.md : {len(ambs)} ambiguïtés')


if __name__ == '__main__':
    if '--import-journal' in sys.argv:
        import_journal(Path(sys.argv[sys.argv.index('--import-journal') + 1]))
    build()
