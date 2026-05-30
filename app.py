from flask import Flask, request, jsonify, send_file, session, send_from_directory
from flask_cors import CORS
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
import io
import os
from datetime import datetime
import json
import sqlite3

print("🚀 APP.PY YÜKLENDI - SQLite İLE (KEEP-ALIVE)")

# Veritabanı başlatma
def init_db():
    try:
        conn = sqlite3.connect('nobet.db')
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS published_tables
                     (id INTEGER PRIMARY KEY, data TEXT, created_at TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS working_data
                     (id INTEGER PRIMARY KEY, data TEXT, created_at TIMESTAMP)''')
        conn.commit()
        conn.close()
        print("✅ SQLite Veritabanı hazırlandı")
    except Exception as e:
        print(f"⚠️ DB hata: {e}")

init_db()

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
    """Sağlık kontrolü + Keep-Alive (Render uyku modundan kaçmak için)"""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})

@app.route('/api/login', methods=['POST'])
def login():
    """Giriş"""
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    user = USERS.get(username)
    if user and user['password'] == password:
        session['username'] = username
        session['role'] = user['role']
        print(f"✅ Auth OK: {username} - {user['role']}")
        return jsonify({'success': True, 'message': 'Giriş başarılı'})
    
    print(f"❌ Auth failed: {username}")
    return jsonify({'success': False, 'message': 'Geçersiz kimlik bilgileri'}), 401

@app.route('/api/logout', methods=['POST'])
def logout():
    """Çıkış"""
    session.clear()
    return jsonify({'success': True, 'message': 'Çıkış başarılı'})

@app.route('/api/check-auth', methods=['GET'])
def check_auth():
    """Oturum kontrolü"""
    authenticated = 'username' in session
    print(f"✅ Auth OK: {session.get('username', 'Yok')}" if authenticated else "❌ Auth failed")
    return jsonify({
        'authenticated': authenticated,
        'username': session.get('username'),
        'role': session.get('role')
    })

# ================== PUBLISH ENDPOINTS ==================

@app.route('/api/publish', methods=['POST'])
def publish():
    """Tabloyu yayınla (sadece admin)"""
    
    if session.get('role') != 'admin':
        return jsonify({'success': False, 'message': 'Yetkiniz yok'}), 403
    
    try:
        data = request.json
        conn = sqlite3.connect('nobet.db')
        c = conn.cursor()
        
        # Son kaydı sil, yenisini ekle
        c.execute('DELETE FROM published_tables')
        c.execute('INSERT INTO published_tables (data, created_at) VALUES (?, ?)',
                  (json.dumps(data), datetime.now()))
        conn.commit()
        conn.close()
        
        print(f"✅ Tablo yayınlandı!")
        return jsonify({'success': True, 'message': 'Tablo yayınlandı'})
    except Exception as e:
        print(f"❌ Publish hatası: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/published', methods=['GET'])
def get_published():
    """Yayınlanan tabloyu getir"""
    try:
        conn = sqlite3.connect('nobet.db')
        c = conn.cursor()
        c.execute('SELECT data FROM published_tables ORDER BY created_at DESC LIMIT 1')
        result = c.fetchone()
        conn.close()
        
        if result is None:
            return jsonify({'success': False, 'message': 'Henüz yayınlanmış tablo yok'}), 404
        
        data = json.loads(result[0])
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        print(f"❌ Get published hatası: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

# ================== WORKING DATA ENDPOINTS ==================

@app.route('/api/working-data', methods=['GET'])
def get_working_data():
    """Çalışma verilerini getir"""
    try:
        conn = sqlite3.connect('nobet.db')
        c = conn.cursor()
        c.execute('SELECT data FROM working_data ORDER BY created_at DESC LIMIT 1')
        result = c.fetchone()
        conn.close()
        
        if result is None:
            return jsonify({'success': False, 'message': 'Henüz çalışma verisi yok'}), 404
        
        data = json.loads(result[0])
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        print(f"❌ Get working data hatası: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/working-data', methods=['POST'])
def save_working_data():
    """Çalışma verilerini kaydet"""
    try:
        data = request.json
        conn = sqlite3.connect('nobet.db')
        c = conn.cursor()
        
        c.execute('DELETE FROM working_data')
        c.execute('INSERT INTO working_data (data, created_at) VALUES (?, ?)',
                  (json.dumps(data), datetime.now()))
        conn.commit()
        conn.close()
        
        print(f"✅ Çalışma verileri kaydedildi")
        return jsonify({'success': True, 'message': 'Çalışma verileri kaydedildi'})
    except Exception as e:
        print(f"❌ Save working data hatası: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

# ================== EXCEL ENDPOINTS ==================

@app.route('/api/create-nobet-listesi', methods=['POST'])
def create_nobet_listesi():
    """Nöbet listesi oluştur (renkli template)"""
    try:
        data = json.loads(request.form.get('data', '{}'))
        
        # Verileri al
        physicians = data.get('physicians', [])
        schedule = data.get('schedule', {})
        year = data.get('year', 2026)
        month = data.get('month', 0)
        daysInMonth = data.get('daysInMonth', 31)
        excuseColor = data.get('excuseColor', 'FFFFFF')
        
        # Excel oluştur
        wb = openpyxl.Workbook()
        ws = wb.active
        
        # Başlık
        ws['A1'] = f"NOBET PROGRAMI - {['Oc', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'][month]} {year}"
        ws['A1'].font = Font(bold=True, size=14)
        
        # Hekim başlıkları
        ws['A2'] = 'GÜN'
        for i, p in enumerate(physicians):
            ws.cell(2, i+2).value = p.get('displayName', p['name'])
            ws.cell(2, i+2).fill = PatternFill(start_color=p['color'].lstrip('#'), end_color=p['color'].lstrip('#'), fill_type="solid")
            ws.cell(2, i+2).font = Font(bold=True, color="000000")
        
        # Nöbet verileri
        dayNames = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt']
        for day in range(1, daysInMonth + 1):
            date = datetime(year, month + 1, day)
            ws[f'A{day+2}'] = f"{day} {dayNames[date.weekday()]}"
            
            for i, p in enumerate(physicians):
                key = f"{p['name']}-{day}"
                value = schedule.get(key, '')
                
                cell = ws.cell(day+2, i+2)
                cell.value = value if value else '-'
                
                # Renkle göster
                if value == '24':
                    cell.fill = PatternFill(start_color=p['color'].lstrip('#'), end_color=p['color'].lstrip('#'), fill_type="solid")
                elif value == 'Mazeret':
                    cell.fill = PatternFill(start_color=excuseColor.lstrip('#'), end_color=excuseColor.lstrip('#'), fill_type="solid")
        
        # Dosyayı gönder
        wb.save('temp.xlsx')
        with open('temp.xlsx', 'rb') as f:
            return send_file(
                io.BytesIO(f.read()),
                mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                as_attachment=True,
                download_name=f'Nobet_{year}_{month+1:02d}.xlsx'
            )
    except Exception as e:
        print(f"❌ Excel oluşturma hatası: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/create-puantaj', methods=['POST'])
def create_puantaj():
    """Puantaj oluştur"""
    try:
        data = json.loads(request.form.get('data', '{}'))
        wb = openpyxl.load_workbook('templates/puantaj.xlsx')
        ws = wb.active
        ws['A1'] = f"PUANTAJ - {data.get('year')}/{data.get('month')}"
        
        with open('temp.xlsx', 'wb') as f:
            wb.save(f)
        with open('temp.xlsx', 'rb') as f:
            return send_file(io.BytesIO(f.read()), mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', as_attachment=True, download_name='Puantaj.xlsx')
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/create-nobet-isimleri', methods=['POST'])
def create_nobet_isimleri():
    """Nöbet isimleri oluştur"""
    try:
        data = json.loads(request.form.get('data', '{}'))
        wb = openpyxl.load_workbook('templates/nobetisimler_template.xlsx')
        ws = wb.active
        ws['A1'] = f"NOBET İSİMLERİ - {data.get('year')}"
        
        with open('temp.xlsx', 'wb') as f:
            wb.save(f)
        with open('temp.xlsx', 'rb') as f:
            return send_file(io.BytesIO(f.read()), mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', as_attachment=True, download_name='NobetIsimleri.xlsx')
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

# ================== STATIC FILES ==================

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    try:
        return send_from_directory('.', path)
    except:
        return "Dosya bulunamadı", 404

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000, debug=False)
