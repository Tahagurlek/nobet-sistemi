from flask import Flask, request, jsonify, send_file, session, send_from_directory
from flask_cors import CORS
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
import io
import os
from datetime import datetime
import json
from pymongo import MongoClient
from pymongo.errors import ServerSelectionTimeoutError

print("🚀 APP.PY YÜKLENDI - MONGODB İLE!")

# MongoDB Bağlantısı
MONGODB_URI = os.environ.get('MONGODB_URI')

if not MONGODB_URI:
    print("❌ HATA: MONGODB_URI environment variable'ı ayarlanmamış!")
    print("Render Dashboard → Environment → MONGODB_URI ekle")
    db = None
else:
    try:
        client = MongoClient(
            MONGODB_URI,
            serverSelectionTimeoutMS=10000,
            connectTimeoutMS=10000,
            socketTimeoutMS=10000,
            retryWrites=True
        )
        
        # Bağlantı test et
        client.admin.command('ping')
        db = client['nobet_db']
        
        print("✅ MongoDB bağlantısı başarılıı!")
        print(f"📊 Database: {db.name}")
        
    except ServerSelectionTimeoutError as e:
        print(f"❌ MongoDB bağlantı hatası: {e}")
        print("⚠️  MongoDB URI kontrolünü yapın")
        db = None
    except Exception as e:
        print(f"❌ Beklenmeyen hata: {e}")
        db = None

app = Flask(__name__, static_folder='.')
app.secret_key = 'nobet-sistemi-secret-key-2026'
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)
app.config['SESSION_COOKIE_SAMESITE'] = 'None'
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True

@app.after_request
def after_request(response):
    response.headers['Access-Control-Allow-Origin'] = request.headers.get('Origin', '*')
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

# Kullanıcılar
USERS = {
    'admin': {'password': 'admin123', 'role': 'admin'},
    'pratisyen': {'password': 'prat123', 'role': 'user'}
}

# ================== AUTH ENDPOINTS ==================

@app.route('/health', methods=['GET', 'HEAD'])
def health():
    """Keep-Alive ping"""
    return jsonify({'status': 'ok', 'mongodb': db is not None})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    user = USERS.get(username)
    if user and user['password'] == password:
        session['username'] = username
        session['role'] = user['role']
        print(f"✅ Giriş OK: {username}")
        return jsonify({'success': True})
    
    return jsonify({'success': False, 'message': 'Geçersiz'}), 401

@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})

@app.route('/api/check-auth', methods=['GET'])
def check_auth():
    return jsonify({
        'authenticated': 'username' in session,
        'username': session.get('username'),
        'role': session.get('role')
    })

# ================== MONGODB ENDPOINTS ==================

@app.route('/api/working-data', methods=['GET'])
def get_working_data():
    """Çalışma verilerini getir (hekimler, nöbetler, tatiller, ay, yıl)"""
    if not db:
        return jsonify({'success': False, 'message': 'Database bağlantı hatası'}), 500
    
    try:
        result = db.working_data.find_one({}, sort=[('created_at', -1)])
        
        if result is None:
            return jsonify({'success': False, 'message': 'Henüz veri yok'}), 404
        
        result.pop('_id', None)
        return jsonify({'success': True, 'data': result['data']})
    except Exception as e:
        print(f"❌ Get working data: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/working-data', methods=['POST'])
def save_working_data():
    """Çalışma verilerini kaydet"""
    if not db:
        return jsonify({'success': False, 'message': 'Database bağlantı hatası'}), 500
    
    try:
        data = request.json
        
        db.working_data.delete_many({})
        db.working_data.insert_one({
            'data': data,
            'created_at': datetime.now()
        })
        
        print(f"✅ Çalışma verileri kaydedildi")
        return jsonify({'success': True})
    except Exception as e:
        print(f"❌ Save working data: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/publish', methods=['POST'])
def publish():
    """Tabloyu yayınla"""
    if session.get('role') != 'admin':
        return jsonify({'success': False, 'message': 'Yetkiniz yok'}), 403
    
    if not db:
        return jsonify({'success': False, 'message': 'Database bağlantı hatası'}), 500
    
    try:
        data = request.json
        
        db.published_tables.delete_many({})
        db.published_tables.insert_one({
            'data': data,
            'created_at': datetime.now()
        })
        
        print(f"✅ Tablo yayınlandı!")
        return jsonify({'success': True})
    except Exception as e:
        print(f"❌ Publish hatası: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/published', methods=['GET'])
def get_published():
    """Yayınlanan tabloyu getir"""
    if not db:
        return jsonify({'success': False, 'message': 'Database bağlantı hatası'}), 500
    
    try:
        result = db.published_tables.find_one({}, sort=[('created_at', -1)])
        
        if result is None:
            return jsonify({'success': False, 'message': 'Henüz yayınlanmış tablo yok'}), 404
        
        result.pop('_id', None)
        return jsonify({'success': True, 'data': result['data']})
    except Exception as e:
        print(f"❌ Get published: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

# ================== EXCEL ENDPOINTS ==================

@app.route('/api/create-nobet-listesi', methods=['POST'])
def create_nobet_listesi():
    """Nöbet listesi (Excel)"""
    try:
        data = json.loads(request.form.get('data', '{}'))
        
        physicians = data.get('physicians', [])
        schedule = data.get('schedule', {})
        year = data.get('year', 2026)
        month = data.get('month', 0)
        daysInMonth = data.get('daysInMonth', 31)
        
        wb = openpyxl.Workbook()
        ws = wb.active
        ws['A1'] = f"NOBET PROGRAMI - {['Oc', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'][month]} {year}"
        ws['A1'].font = Font(bold=True, size=14)
        
        ws['A2'] = 'GÜN'
        for i, p in enumerate(physicians):
            ws.cell(2, i+2).value = p.get('displayName', p['name'])
            ws.cell(2, i+2).fill = PatternFill(start_color=p['color'].lstrip('#'), end_color=p['color'].lstrip('#'), fill_type="solid")
            ws.cell(2, i+2).font = Font(bold=True)
        
        dayNames = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt']
        for day in range(1, daysInMonth + 1):
            date = datetime(year, month + 1, day)
            ws[f'A{day+2}'] = f"{day} {dayNames[date.weekday()]}"
            
            for i, p in enumerate(physicians):
                key = f"{p['name']}-{day}"
                value = schedule.get(key, '-')
                ws.cell(day+2, i+2).value = value
                
                if value in ['24 Saat', '16 Saat', '8 Saat']:
                    ws.cell(day+2, i+2).fill = PatternFill(start_color=p['color'].lstrip('#'), end_color=p['color'].lstrip('#'), fill_type="solid")
        
        wb.save('temp.xlsx')
        with open('temp.xlsx', 'rb') as f:
            return send_file(
                io.BytesIO(f.read()),
                mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                as_attachment=True,
                download_name=f'Nobet_{year}_{month+1:02d}.xlsx'
            )
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/create-puantaj', methods=['POST'])
def create_puantaj():
    """Puantaj (Excel)"""
    return jsonify({'success': True})

@app.route('/api/create-nobet-isimleri', methods=['POST'])
def create_nobet_isimleri():
    """Nöbet isimleri (Excel)"""
    return jsonify({'success': True})

# ================== STATIC ==================

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    try:
        return send_from_directory('.', path)
    except:
        return "Not found", 404

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000, debug=False)
