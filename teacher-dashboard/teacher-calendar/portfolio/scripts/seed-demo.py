#!/usr/bin/env python3
# 学生成长档案工作台 —— 演示数据脚本（通过 API 录入，走完整校验/加密逻辑）
# 用法：python3 scripts/seed-demo.py   （需 API 在 8797）
import json
import urllib.request

BASE = 'http://127.0.0.1:8797/api/portfolio'

def api(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def post(path, body):
    d = api('POST', path, body)
    if not d.get('ok'):
        print(f'  ! {path}: {d.get("reason")}')
    return d

C = {}   # 班级 id
def mk_class(key, name, grade, stage, role):
    d = post('/classes', {'name': name, 'grade': grade, 'stage': stage, 'role': role})
    if d.get('ok'): C[key] = d['class']['id']
    return C.get(key)

def mk_stu(cid, name, no, **kw):
    body = {'name': name, 'student_no': no, **kw}
    d = post(f'/classes/{cid}/students', body)
    return d['student']['id'] if d.get('ok') else None

def mk_exam(cid, name, type_, date):
    d = post(f'/classes/{cid}/exams', {'name': name, 'type': type_, 'date': date})
    return d['exam']['id'] if d.get('ok') else None

def mk_scores(exam_id, rows):
    d = api('POST', f'/exams/{exam_id}/scores/batch', {'rows': rows})
    if d.get('failed'):
        print(f'  ! scores failed {d["failed"]}: {d.get("errors")}')
    return d.get('upserted', 0)

def mk_assign(cid, subject, date, title):
    d = post(f'/classes/{cid}/assignments', {'subject': subject, 'date': date, 'title': title})
    return d['assignment']['id'] if d.get('ok') else None

def mk_hw_records(aid, rows):
    d = api('POST', f'/assignments/{aid}/records/batch', {'rows': rows})
    if d.get('failed'): print(f'  ! hw failed {d["failed"]}: {d.get("errors")}')

def mk_moral(sid, date, cat, content, follow='', result=''):
    post(f'/students/{sid}/moral-records', {'date': date, 'category': cat, 'content': content, 'follow_up': follow, 'result': result})

# ---------- 1. 班级 ----------
print('== 创建班级 ==')
main = mk_class('main', '初一(5)班', '初一', 'middle', 'homeroom')
df3  = mk_class('df3',  '初一(3)班', '初一', 'middle', 'subject')
p1   = mk_class('p1',   '四(1)班', '四年级', 'primary', 'subject')
p2   = mk_class('p2',   '四(2)班', '四年级', 'primary', 'subject')

# ---------- 2. 学生（主班 9 人，带敏感字段演示加密） ----------
print('== 主班学生（9人）==')
st = {}
st['lixiang'] = mk_stu(C['main'], '李想', '20260101', gender='男', birth_date='2011-09-01',
    school_id='G20260101', id_card='420111201109011234', address='湖北省武汉市武昌区',
    parent1_name='李建国', parent1_phone='13800005678', special_note='单亲，随母',
    allergy_note='青霉素过敏', is_boarding=1, pressure_level='中', goal_note='重点高中')
st['zhangxy'] = mk_stu(C['main'], '张小雨', '20260102', gender='女', birth_date='2011-11-15',
    school_id='G20260102', id_card='420111201111151234', address='湖北省武汉市洪山区',
    parent1_name='张伟', parent1_phone='13900001234', pressure_level='中')
st['wangxm'] = mk_stu(C['main'], '王晓明', '20260103', gender='男', birth_date='2011-03-20',
    is_boarding=1, pressure_level='高', goal_note='目标实验班')
st['chenchen'] = mk_stu(C['main'], '陈晨', '20260104', gender='男', birth_date='2011-06-08',
    special_note='家庭矛盾', allergen_note='', pressure_level='高')
st['liuyang'] = mk_stu(C['main'], '刘洋', '20260105', gender='男', birth_date='2011-12-02', pressure_level='中')
st['zhouyue'] = mk_stu(C['main'], '周悦', '20260106', gender='女', birth_date='2011-04-11', is_boarding=1, pressure_level='低')
st['wuhao'] = mk_stu(C['main'], '吴昊', '20260107', gender='男', birth_date='2011-08-25', pressure_level='中')
st['zhengs'] = mk_stu(C['main'], '郑爽', '20260108', gender='女', birth_date='2011-01-30', pressure_level='中')
st['sunyue'] = mk_stu(C['main'], '孙悦', '20260109', gender='女', birth_date='2011-07-19', pressure_level='低')

print('== 代课班学生 ==')
p1s = {}; p2s = {}; df3s = {}
for n, no in [('王小宝','40101'),('李娜','40102'),('张强','40103'),('赵敏','40104')]:
    p1s[n] = mk_stu(C['p1'], n, no, subject_note='课堂积极')
for n, no in [('刘一','40201'),('陈二','40202'),('杨三','40203'),('周四','40204'),('吴五','40205')]:
    p2s[n] = mk_stu(C['p2'], n, no)
for n, no in [('郑一','30101'),('王二','30102'),('冯三','30103')]:
    df3s[n] = mk_stu(C['df3'], n, no)

# ---------- 3. 主班成绩（3 次考试，触发成绩趋势/进步退步） ----------
print('== 主班成绩 ==')
e1 = mk_exam(C['main'], '分班测试', 'placement', '2026-09-05')
e2 = mk_exam(C['main'], '月考', 'monthly', '2026-10-15')
e3 = mk_exam(C['main'], '期中考试', 'midterm', '2026-11-10')
# 成绩表：李想稳步进步(80→85→90)，张小雨稳定(75→74→76)，陈晨退步(82→70→62)，其余中等
scores = {
    'lixiang':  [('语文',80),('数学',85),('道德与法治',88),('总分',253)],
    'zhangxy':  [('语文',75),('数学',70),('道德与法治',80),('总分',225)],
    'wangxm':   [('语文',70),('数学',65),('道德与法治',75),('总分',210)],
    'chenchen': [('语文',82),('数学',80),('道德与法治',85),('总分',247)],
    'liuyang':  [('语文',68),('数学',72),('道德与法治',70),('总分',210)],
    'zhouyue':  [('语文',88),('数学',82),('道德与法治',90),('总分',260)],
    'wuhao':    [('语文',72),('数学',68),('道德与法治',74),('总分',214)],
    'zhengs':   [('语文',64),('数学',60),('道德与法治',68),('总分',192)],
    'sunyue':   [('语文',90),('数学',86),('道德与法治',92),('总分',268)],
}
# 三次考试按难度微调
adjust = {e1: 0, e2: 3, e3: 5}  # 期中题稍难 → 总分含一定区分
for eid, delta in adjust.items():
    rows = []
    for skey, subs in scores.items():
        sid = st.get(skey)
        if not sid: continue
        for i, (sub, sc) in enumerate(subs):
            # 第三次(期中) 李想+5进步、陈晨-20退步
            sc2 = sc + delta
            if eid == e3 and skey == 'lixiang': sc2 += 5
            if eid == e3 and skey == 'chenchen': sc2 -= 20
            rows.append({'student_id': sid, 'subject': sub, 'score': max(40, sc2),
                'class_rank': None if sub == '总分' else None})
    mk_scores(eid, rows)

# ---------- 4. 代课班道法成绩（触发道法对比） ----------
print('== 道法成绩 ==')
df_exams = {}
for key, cid in [('df3', C['df3']), ('p1', C['p1']), ('p2', C['p2'])]:
    df_exams[key] = mk_exam(cid, '道法随堂', 'subject', '2026-11-05')
# 各班道法成绩
df_scores = {
    'df3': [('郑一', 72), ('王二', 80), ('冯三', 65)],
    'p1':  [('王小宝', 90), ('李娜', 85), ('张强', 78), ('赵敏', 88)],
    'p2':  [('刘一', 82), ('陈二', 70), ('杨三', 92), ('周四', 75), ('吴五', 86)],
}
for key, rows in df_scores.items():
    rlist = []
    for n, sc in rows:
        sid = (p1s if key == 'p1' else p2s if key == 'p2' else df3s).get(n)
        if sid: rlist.append({'student_id': sid, 'subject': '道德与法治', 'score': sc})
    mk_scores(df_exams[key], rlist)

# ---------- 5. 主班作业（李想缺交+敷衍≥3 → 需关注；陈晨缺交3次 → 重点关注） ----------
print('== 作业与登记 ==')
for i, (subj, date) in enumerate([('数学', '2026-10-20'), ('语文', '2026-10-21'), ('英语', '2026-10-22')]):
    aid = mk_assign(C['main'], subj, date, f'{subj}练习册 P{i+1}-{i+3}')
    if not aid: continue
    rows = []
    for n, no in [('李想', '20260101'), ('张小雨', '20260102'), ('王晓明', '20260103'), ('陈晨', '20260104')]:
        sid = st.get({'李想':'lixiang','张小雨':'zhangxy','王晓明':'wangxm','陈晨':'chenchen'}[n])
        if not sid: continue
        # 李想：第1次缺交、第2次缺交、第3次敷衍（≥3 → 需关注）
        # 陈晨：3 次缺交（重点关注）
        if n == '李想':
            status = 'missing' if i < 2 else 'slack'
        elif n == '陈晨':
            status = 'missing'
        else:
            status = 'excellent' if i == 0 else 'normal'
        rows.append({'student_id': sid, 'status': status, 'issue_note': '' if status != 'missing' else '未交', 'rectify_note': '次日补交' if status == 'missing' else ''})
    mk_hw_records(aid, rows)

# ---------- 6. 德育记录（王XX 心理重点关注；陈XX 品德榜样） ----------
print('== 德育记录 ==')
mk_moral(st['chenchen'], '2026-11-11', 'emotion', '期中考试退步后情绪低落', '已谈心疏导', '状态好转')
mk_moral(st['chenchen'], '2026-11-18', 'emotion', '再次情绪波动，焦虑', '已与家长沟通', '持续关注')
mk_moral(st['liuyang'], '2026-11-12', 'volunteer', '主动帮助同学讲解题目', '表扬', '班级表彰')
mk_moral(st['zhouyue'], '2026-11-15', 'conduct', '课堂纪律良好，作业认真', '', '')

# ---------- 7. 荣誉 / 特长 ----------
print('== 荣誉与特长 ==')
post(f"/students/{st['lixiang']}/honors", {'title': '跳绳一等奖', 'level': 'school', 'event': '校运会', 'date': '2026-09-18'})
post(f"/students/{st['zhouyue']}/honors", {'title': '区三好学生', 'level': 'district', 'event': '区评优', 'date': '2026-06-01'})
post(f"/students/{st['lixiang']}/talents", {'category': '艺术', 'name': '钢琴', 'level': '八级', 'potential': '潜力大'})
post(f"/students/{st['sunyue']}/talents", {'category': '体育', 'name': '篮球', 'level': '校篮球队', 'potential': ''})
post(f"/classes/{C['main']}/honors", {'title': '文明班级', 'level': 'school', 'event': '十月评比', 'date': '2026-10-30'})

print('\n✅ 演示数据录入完成')
print(f'班级：{len([k for k in C if C.get(k)])} 个')
