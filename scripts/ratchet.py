#!/usr/bin/env python3
"""基线棘轮：把检测器的发现与基线比对，只许变好。只做比对，不做检测。

检测器输出（JSON，文件或 stdin 的 "-"）：
  {
    "guard": "complexity",            # 守卫名，须与基线一致
    "scanned": 640,                   # 实际扫描的单位数（文件、函数……）
    "min_scanned": 100,               # 低于此值说明遍历坏了（防空转通过），可省略
    "parse_failures": ["a.py"],       # 解析失败的文件，任何一个都算失败
    "hard": ["a_test.py:3 提交了 .only"],   # 直接失败、不进基线的违规
    "findings": [                     # 进基线的发现；同一 rule+key 出现多次会累加
      {"rule": "fn-complexity", "key": "src/a.py#parse", "count": 41, "detail": "可选说明"}
    ]
  }

基线（JSON）：
  {"version": 1, "guard": "complexity", "entries": {"fn-complexity": {"src/a.py#parse": 41}}}

用法：
  ratchet.py check  --findings F.json --baseline B.json
  ratchet.py update --findings F.json --baseline B.json
  ratchet.py conformance [cases.json]

退出码：0 通过 / 1 未通过 / 2 用法或输入错误
"""

import argparse
import json
import os
import sys

BASELINE_VERSION = 1


class InputError(Exception):
    pass


def load_json(path):
    if path == '-':
        return json.load(sys.stdin)
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def current_entries(findings_doc):
    entries = {}
    for item in findings_doc.get('findings', []):
        rule, key = item.get('rule'), item.get('key')
        if not rule or not key:
            raise InputError(f'发现缺少 rule 或 key: {item}')
        count = item.get('count', 1)
        if not isinstance(count, int) or count < 0:
            raise InputError(f'count 必须是非负整数: {item}')
        bucket = entries.setdefault(rule, {})
        bucket[key] = bucket.get(key, 0) + count
    return {rule: {k: v for k, v in keys.items() if v > 0} for rule, keys in entries.items()}


def incomplete_scan(findings_doc):
    """扫描本身不可信：解析失败或扫描数低于下限。此时既不能判通过，也不能写基线。"""
    problems = [f'解析失败：{p}' for p in findings_doc.get('parse_failures', [])]
    scanned = findings_doc.get('scanned')
    floor = findings_doc.get('min_scanned', 1)
    if scanned is None or scanned < floor:
        problems.append(f'扫描数 {scanned} 低于下限 {floor}，遍历可能坏了')
    return problems


def blocking_problems(findings_doc):
    """不看基线也成立的失败：扫描不可信 + 硬规则违规。"""
    return incomplete_scan(findings_doc) + [f'硬规则：{h}' for h in findings_doc.get('hard', [])]


def compare(findings_doc, baseline_doc):
    """返回 {'pass', 'blocking', 'added', 'grew', 'stale'}；三类差异都是 'rule:key' 字符串列表。"""
    if baseline_doc is None:
        baseline_doc = {'version': BASELINE_VERSION, 'guard': findings_doc.get('guard'), 'entries': {}}
    if baseline_doc.get('version') != BASELINE_VERSION:
        raise InputError(f"不支持的基线版本: {baseline_doc.get('version')}")
    if baseline_doc.get('guard') != findings_doc.get('guard'):
        raise InputError(f"基线属于 {baseline_doc.get('guard')}，发现属于 {findings_doc.get('guard')}")
    now = current_entries(findings_doc)
    recorded = baseline_doc.get('entries', {})
    added, grew, stale = [], [], []
    for rule, keys in now.items():
        for key, count in keys.items():
            base = recorded.get(rule, {}).get(key)
            if base is None:
                added.append(f'{rule}:{key}')
            elif count > base:
                grew.append(f'{rule}:{key}')
    for rule, keys in recorded.items():
        for key, base in keys.items():
            if now.get(rule, {}).get(key, 0) < base:
                stale.append(f'{rule}:{key}')
    blocking = blocking_problems(findings_doc)
    result = {'blocking': blocking, 'added': sorted(added), 'grew': sorted(grew), 'stale': sorted(stale)}
    result['pass'] = not (blocking or added or grew or stale)
    return result


def build_baseline(findings_doc):
    now = current_entries(findings_doc)
    entries = {rule: dict(sorted(keys.items())) for rule, keys in sorted(now.items()) if keys}
    return {'version': BASELINE_VERSION, 'guard': findings_doc.get('guard'), 'entries': entries}


def detail_of(findings_doc):
    return {f"{f['rule']}:{f['key']}": f.get('detail') for f in findings_doc.get('findings', []) if f.get('detail')}


def report(result, findings_doc, baseline_doc, update_hint):
    guard = findings_doc.get('guard')
    if result['pass']:
        print(f"✓ {guard} 守卫通过：扫描 {findings_doc.get('scanned')}，基线外无新增")
        return
    details = detail_of(findings_doc)
    recorded = (baseline_doc or {}).get('entries', {})
    now = current_entries(findings_doc)

    def counts(item):
        rule, key = item.split(':', 1)
        return recorded.get(rule, {}).get(key, 0), now.get(rule, {}).get(key, 0)

    print(f'✖ {guard} 守卫未通过', file=sys.stderr)
    sections = [
        ('必须直接修掉（不能进基线）', result['blocking'], lambda i: i),
        ('新增违规（修掉；确属有意保留就更新基线并在提交说明写理由）', result['added'],
         lambda i: f"{i}（{counts(i)[1]}）{' — ' + details[i] if i in details else ''}"),
        ('基线条目变差（只许降不许升）', result['grew'], lambda i: f'{i}：{counts(i)[0]} → {counts(i)[1]}'),
        (f'基线虚挂（已改善或已消失），运行 {update_hint} 清掉', result['stale'],
         lambda i: f'{i}：记的是 {counts(i)[0]}，实际 {counts(i)[1]}'),
    ]
    for title, items, fmt in sections:
        if items:
            print(f'\n{title}：', file=sys.stderr)
            for item in items:
                print(f'  {fmt(item)}', file=sys.stderr)


def cmd_check(args):
    findings_doc = load_json(args.findings)
    baseline_doc = load_json(args.baseline) if os.path.exists(args.baseline) else None
    result = compare(findings_doc, baseline_doc)
    report(result, findings_doc, baseline_doc, args.update_command or 'update')
    return 0 if result['pass'] else 1


def cmd_update(args):
    findings_doc = load_json(args.findings)
    incomplete = incomplete_scan(findings_doc)
    if incomplete:
        for p in incomplete:
            print(p, file=sys.stderr)
        print('✖ 扫描不完整，拒绝写基线', file=sys.stderr)
        return 1
    baseline = build_baseline(findings_doc)
    os.makedirs(os.path.dirname(os.path.abspath(args.baseline)), exist_ok=True)
    with open(args.baseline, 'w', encoding='utf-8') as fh:
        json.dump(baseline, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    total = sum(len(keys) for keys in baseline['entries'].values())
    print(f'基线已更新：{args.baseline}（{total} 条）')
    hard = findings_doc.get('hard', [])
    if hard:
        for h in hard:
            print(f'硬规则：{h}', file=sys.stderr)
        print('✖ 硬规则违规不能进基线，仍需修掉', file=sys.stderr)
        return 1
    return 0


def cmd_conformance(args):
    path = args.cases or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'conformance', 'cases.json')
    cases = load_json(path)
    failed = 0
    for case in cases:
        try:
            if case.get('mode') == 'update':
                got = build_baseline(case['findings'])
                ok = got == case['expect_baseline']
            else:
                got = compare(case['findings'], case.get('baseline'))
                expect = case['expect']
                ok = all(got[k] == expect[k] for k in ('pass', 'added', 'grew', 'stale')) \
                    and len(got['blocking']) == expect.get('blocking_count', 0)
        except InputError as err:
            got = f'InputError: {err}'
            ok = case.get('expect_error', False)
        if case.get('expect_error') and not isinstance(got, str):
            ok = False
        print(f"{'✓' if ok else '✖'} {case['name']}")
        if not ok:
            failed += 1
            print(f'    实际：{json.dumps(got, ensure_ascii=False)}')
    print(f'{len(cases) - failed}/{len(cases)} 通过')
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description='基线棘轮：只许变好')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('check', 'update'):
        p = sub.add_parser(name)
        p.add_argument('--findings', required=True)
        p.add_argument('--baseline', required=True)
        p.add_argument('--update-command', help='失败提示里展示的更新基线命令')
    p = sub.add_parser('conformance')
    p.add_argument('cases', nargs='?')
    args = parser.parse_args()
    try:
        return {'check': cmd_check, 'update': cmd_update, 'conformance': cmd_conformance}[args.command](args)
    except (InputError, json.JSONDecodeError, FileNotFoundError) as err:
        print(f'✖ {err}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
