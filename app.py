"""Acil Servis Nöbet Sistemi — Flask sunucusu.

Ortam değişkenleri:
  MONGODB_URI      MongoDB Atlas bağlantısı (yoksa yerel SQLite kullanılır: sadece geliştirme için)
  ADMIN_PASSWORD   yönetici (admin) şifresi
  USER_PASSWORD    pratisyen (görüntüleme) şifresi
  SECRET_KEY       oturum anahtarı
  INSECURE_COOKIES=1  yerel http testinde çerezlerin çalışması için
"""
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, redirect, request, send_file, send_from_directory, session

import exports
import model

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.environ.get('INSECURE_COOKIES') != '1',
    SESSION_COOKIE_HTTPONLY=True,
    MAX_CONTENT_LENGTH=4 * 1024 * 1024,
)

# ================== KULLANICILAR ==================
# Şifreler ortam değişkenlerinden okunur; ayarlanmamış hesap kapalıdır.
USERS = {}
if os.environ.get('ADMIN_PASSWORD'):
    USERS['admin'] = {'password': os.environ['ADMIN_PASSWORD'], 'role': 'admin'}
if os.environ.get('USER_PASSWORD'):
    USERS['pratisyen'] = {'password': os.environ['USER_PASSWORD'], 'role': 'user'}
if not USERS:
    print('⚠️  ADMIN_PASSWORD / USER_PASSWORD ayarlanmamış: giriş kapalı')


# ================== DEPOLAMA ==================
class Conflict(Exception):
    """Veri başka bir cihazda değişmiş (revizyon uyuşmuyor)."""


class StorageUnavailable(Exception):
    pass


class MongoStore:
    def __init__(self, uri):
        from pymongo import MongoClient
        from pymongo import errors
        self.errors = errors
        # Bağlantı tembeldir: ilk istekte kurulur, koparsa sonraki istekte yeniden denenir.
        self.client = MongoClient(uri, serverSelectionTimeoutMS=8000, connectTimeoutMS=8000,
                                  socketTimeoutMS=15000, retryWrites=True)
        self.db = self.client['nobet_db']
        self.col = self.db['app_state']

    def _wrap(self, fn):
        try:
            return fn()
        except self.errors.PyMongoError as e:
            print('❌ MongoDB hatası: %s' % e)
            raise StorageUnavailable(str(e))

    def load(self, name):
        doc = self._wrap(lambda: self.col.find_one({'_id': name}))
        return (doc['data'], doc['rev']) if doc else (None, 0)

    def save(self, name, data, base_rev):
        now = datetime.now(timezone.utc)
        if base_rev == 0:
            try:
                self.col.insert_one({'_id': name, 'data': data, 'rev': 1, 'updated_at': now})
            except self.errors.DuplicateKeyError:
                raise Conflict()
            except self.errors.PyMongoError as e:
                raise StorageUnavailable(str(e))
            return 1
        res = self._wrap(lambda: self.col.update_one(
            {'_id': name, 'rev': base_rev},
            {'$set': {'data': data, 'rev': base_rev + 1, 'updated_at': now}}))
        if res.matched_count == 0:
            raise Conflict()
        return base_rev + 1

    def put(self, name, data):
        self._wrap(lambda: self.col.update_one(
            {'_id': name}, {'$set': {'data': data, 'updated_at': datetime.now(timezone.utc)},
                            '$inc': {'rev': 1}}, upsert=True))

    def list_prefix(self, prefix):
        docs = self._wrap(lambda: list(self.col.find({'_id': {'$regex': '^' + re.escape(prefix)}})))
        return [d['data'] for d in docs]

    def legacy(self, collection):
        doc = self._wrap(lambda: self.db[collection].find_one({}, sort=[('created_at', -1)]))
        return doc.get('data') if doc else None


class SqliteStore:
    """Sadece yerel geliştirme için. Render'da disk kalıcı değildir."""

    def __init__(self, path):
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute('CREATE TABLE IF NOT EXISTS app_state '
                          '(name TEXT PRIMARY KEY, data TEXT, rev INTEGER, updated_at TEXT)')
        self.conn.commit()

    def load(self, name):
        with self.lock:
            row = self.conn.execute('SELECT data, rev FROM app_state WHERE name=?', (name,)).fetchone()
        return (json.loads(row[0]), row[1]) if row else (None, 0)

    def save(self, name, data, base_rev):
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            if base_rev == 0:
                try:
                    self.conn.execute('INSERT INTO app_state VALUES (?,?,1,?)',
                                      (name, json.dumps(data), now))
                except sqlite3.IntegrityError:
                    raise Conflict()
                self.conn.commit()
                return 1
            cur = self.conn.execute('UPDATE app_state SET data=?, rev=?, updated_at=? '
                                    'WHERE name=? AND rev=?',
                                    (json.dumps(data), base_rev + 1, now, name, base_rev))
            self.conn.commit()
            if cur.rowcount == 0:
                raise Conflict()
            return base_rev + 1

    def put(self, name, data):
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            self.conn.execute('INSERT INTO app_state VALUES (?,?,1,?) ON CONFLICT(name) DO UPDATE '
                              'SET data=excluded.data, rev=app_state.rev+1, updated_at=excluded.updated_at',
                              (name, json.dumps(data), now))
            self.conn.commit()

    def list_prefix(self, prefix):
        with self.lock:
            rows = self.conn.execute('SELECT data FROM app_state WHERE name LIKE ?',
                                     (prefix.replace('%', '') + '%',)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def legacy(self, collection):
        return None


if os.environ.get('MONGODB_URI'):
    store = MongoStore(os.environ['MONGODB_URI'])
    print('🗄️  Depolama: MongoDB')
else:
    store = SqliteStore(os.path.join(BASE_DIR, 'nobet_local.db'))
    print('🗄️  Depolama: yerel SQLite (MONGODB_URI yok — sadece geliştirme)')

WORKING = 'working'
PUBLISHED_PREFIX = 'published:'


def load_working():
    data, rev = store.load(WORKING)
    if data is None:
        # İlk açılış: eski sürümün verisi varsa yeni yapıya taşı
        legacy = store.legacy('working_data')
        doc = model.migrate_legacy(legacy) if legacy else model.default_doc()
        try:
            rev = store.save(WORKING, doc, 0)
        except Conflict:
            data, rev = store.load(WORKING)
            return model.normalize(data), rev
        print('✅ Çalışma verisi oluşturuldu%s' % (' (eski veriden taşındı)' if legacy else ''))
        return doc, rev
    return model.normalize(data), rev


def published_all():
    snaps = {s['ym']: s for s in store.list_prefix(PUBLISHED_PREFIX) if s.get('ym')}
    if not snaps:
        legacy = store.legacy('published_tables')
        if legacy:
            doc = model.migrate_legacy(legacy)
            for ym in doc['months']:
                snaps[ym] = make_snapshot(doc, ym, published_at=None)
    return snaps


def make_snapshot(doc, ym, published_at):
    return {
        'version': 2,
        'ym': ym,
        'publishedAt': published_at,
        'settings': doc['settings'],
        'physicians': model.month_physicians(doc, ym),
        'month': model.get_month(doc, ym),
    }


# ================== DOĞRULAMA ==================
YM_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')
KEY_RE = re.compile(r'^[A-Za-z0-9_]+-([1-9]|[12]\d|3[01])$')


def validate_doc(doc):
    if not isinstance(doc, dict):
        raise ValueError('Veri biçimi hatalı')
    phys = doc.get('physicians')
    if not isinstance(phys, list) or len(phys) > 200:
        raise ValueError('Hekim listesi hatalı')
    ids = set()
    for p in phys:
        if not isinstance(p, dict) or not isinstance(p.get('id'), str) or not isinstance(p.get('name'), str):
            raise ValueError('Hekim kaydı hatalı')
        if not re.fullmatch(r'[A-Za-z0-9_]{1,40}', p['id']) or p['id'] in ids:
            raise ValueError('Hekim kimliği hatalı')
        ids.add(p['id'])
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}', p.get('color') or ''):
            raise ValueError('Renk hatalı: %s' % p['name'])
    months = doc.get('months')
    if not isinstance(months, dict):
        raise ValueError('Ay verisi hatalı')
    for ym, m in months.items():
        if not YM_RE.match(ym) or not isinstance(m, dict):
            raise ValueError('Ay hatalı: %s' % ym)
        sched = m.get('schedule', {})
        if not isinstance(sched, dict):
            raise ValueError('Çizelge hatalı')
        for k, v in sched.items():
            if not KEY_RE.match(k) or not isinstance(v, str) or len(v) > 8:
                raise ValueError('Çizelge hücresi hatalı')
        hol = m.get('holidays', [])
        if not isinstance(hol, list) or not all(isinstance(d, int) and 1 <= d <= 31 for d in hol):
            raise ValueError('Tatil listesi hatalı')
    settings = doc.get('settings')
    if not isinstance(settings, dict):
        raise ValueError('Ayarlar hatalı')
    doc = model.normalize(doc)
    for key, val in doc['settings']['colors'].items():
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(val)):
            raise ValueError('Renk ayarı hatalı: %s' % key)
    excuses = doc['settings']['excuses']
    if not isinstance(excuses, list) or not all(
            isinstance(e, dict) and re.fullmatch(r'[A-ZÇĞİÖŞÜ]{1,4}', str(e.get('code', '')))
            for e in excuses):
        raise ValueError('Mazeret kodları hatalı (1-4 büyük harf)')
    return doc


# ================== YARDIMCILAR ==================
def require(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            if 'role' not in session:
                return jsonify({'success': False, 'message': 'Oturum kapalı'}), 401
            if role and session['role'] != role:
                return jsonify({'success': False, 'message': 'Yetkiniz yok'}), 403
            try:
                return fn(*a, **kw)
            except StorageUnavailable:
                return jsonify({'success': False,
                                'message': 'Veritabanına ulaşılamıyor. Biraz sonra tekrar deneyin.'}), 503
        return wrapper
    return deco


_failed = {}


def _too_many_attempts(ip):
    now = time.time()
    attempts = [t for t in _failed.get(ip, []) if now - t < 300]
    _failed[ip] = attempts
    return len(attempts) >= 10


# ================== AUTH ==================
@app.route('/health', methods=['GET', 'HEAD'])
def health():
    return jsonify({'status': 'ok'})


@app.route('/api/login', methods=['POST'])
def login():
    ip = request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip()
    if _too_many_attempts(ip):
        return jsonify({'success': False, 'message': 'Çok fazla deneme. 5 dakika sonra tekrar deneyin.'}), 429
    data = request.get_json(silent=True) or {}
    username = str(data.get('username') or '')
    password = str(data.get('password') or '')
    user = USERS.get(username)
    if user and password and hmac.compare_digest(user['password'], password):
        session.clear()
        session['username'] = username
        session['role'] = user['role']
        return jsonify({'success': True, 'role': user['role']})
    _failed.setdefault(ip, []).append(time.time())
    return jsonify({'success': False, 'message': 'Kullanıcı adı veya şifre hatalı'}), 401


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})


@app.route('/api/check-auth', methods=['GET'])
def check_auth():
    if 'role' in session:
        return jsonify({'authenticated': True, 'username': session['username'], 'role': session['role']})
    return jsonify({'authenticated': False})


# ================== VERİ ==================
@app.route('/api/working-data', methods=['GET'])
@require('admin')
def get_working():
    doc, rev = load_working()
    return jsonify({'success': True, 'data': doc, 'rev': rev, 'published': published_all()})


@app.route('/api/working-data', methods=['POST'])
@require('admin')
def save_working():
    body = request.get_json(silent=True) or {}
    try:
        doc = validate_doc(body.get('data'))
        base_rev = int(body.get('baseRev', -1))
    except (ValueError, TypeError) as e:
        return jsonify({'success': False, 'message': str(e)}), 400
    try:
        rev = store.save(WORKING, doc, base_rev)
    except Conflict:
        current, cur_rev = load_working()
        return jsonify({'success': False, 'conflict': True, 'data': current, 'rev': cur_rev,
                        'message': 'Veri başka bir cihazda değiştirilmiş'}), 409
    return jsonify({'success': True, 'rev': rev})


@app.route('/api/publish', methods=['POST'])
@require('admin')
def publish():
    ym = str((request.get_json(silent=True) or {}).get('ym') or '')
    if not YM_RE.match(ym):
        return jsonify({'success': False, 'message': 'Geçersiz ay'}), 400
    doc, _ = load_working()
    snap = make_snapshot(doc, ym, datetime.now(timezone.utc).isoformat())
    store.put(PUBLISHED_PREFIX + ym, snap)
    return jsonify({'success': True, 'snapshot': snap})


@app.route('/api/published', methods=['GET'])
@require()
def get_published():
    snaps = published_all()
    available = sorted(snaps)
    ym = request.args.get('ym') or (available[-1] if available else None)
    return jsonify({'success': True, 'available': available, 'data': snaps.get(ym)})


@app.route('/api/export/<kind>', methods=['GET'])
@require()
def export(kind):
    builder = exports.BUILDERS.get(kind)
    ym = request.args.get('ym', '')
    if not builder or not YM_RE.match(ym):
        return jsonify({'success': False, 'message': 'Geçersiz istek'}), 400
    if session['role'] == 'admin' and request.args.get('source') != 'published':
        doc, _ = load_working()
    else:
        snap = published_all().get(ym)
        if not snap:
            return jsonify({'success': False, 'message': 'Bu ay yayınlanmamış'}), 404
        doc = {'settings': snap['settings'], 'physicians': snap['physicians'],
               'months': {ym: snap['month']}}
    buf, filename = builder(doc, ym)
    return send_file(buf, as_attachment=True, download_name=filename,
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ================== SAYFALAR ==================
@app.route('/')
def index():
    return redirect('/nobet_login.html')


@app.route('/<path:path>')
def static_files(path):
    # Yalnızca public/ klasörü dışarıya açıktır (kaynak kod ve şablonlar değil)
    resp = send_from_directory(PUBLIC_DIR, path, max_age=0)
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    return resp


@app.after_request
def no_cache_api(resp):
    if request.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-store'
    return resp


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)
