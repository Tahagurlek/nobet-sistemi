"""Nöbet sistemi veri modeli ve ortak kurallar.

Veri yapısı (version 2):
{
  "version": 2,
  "settings": {...},                       # kurum, imza, mazeret kodları, renkler
  "physicians": [{id, name, displayName, color, tc, title, active}],
  "months": {"2026-10": {"schedule": {"<id>-<gün>": "24"}, "holidays": [3, 4]}}
}

Hekimler sabit bir ID ile tutulur; ad değişikliği nöbetleri etkilemez.
Bu dosyadaki kurallar arayüzdeki (public/app.js) kurallarla birebir aynıdır.
"""
import calendar
import copy
import re
import secrets

MONTHS_TR = ['OCAK', 'ŞUBAT', 'MART', 'NİSAN', 'MAYIS', 'HAZİRAN',
             'TEMMUZ', 'AĞUSTOS', 'EYLÜL', 'EKİM', 'KASIM', 'ARALIK']
DAYS_TR = ['PAZARTESİ', 'SALI', 'ÇARŞAMBA', 'PERŞEMBE', 'CUMA', 'CUMARTESİ', 'PAZAR']
SHIFT_HOURS = {'24': 24, '16': 16, '8': 8}

DEFAULT_EXCUSES = [
    {'code': 'YI', 'label': 'Yıllık İzin', 'puantaj': 'Yİ'},
    {'code': 'R', 'label': 'Raporlu', 'puantaj': 'R'},
    {'code': 'EV', 'label': 'Evlilik İzni', 'puantaj': 'EV'},
    {'code': 'EI', 'label': 'Eğitim İzni', 'puantaj': 'Eİ'},
    {'code': 'GO', 'label': 'Görevlendirme', 'puantaj': 'GÖ'},
    {'code': 'MI', 'label': 'Mazeret İzni', 'puantaj': 'Mİ'},
    {'code': 'OI', 'label': 'Ölüm İzni', 'puantaj': 'Öİ'},
    {'code': 'RI', 'label': 'Refakat İzni', 'puantaj': 'Rİ'},
    {'code': 'SEI', 'label': 'Sendika İzni', 'puantaj': 'SEİ'},
    {'code': 'KI', 'label': 'Kongre İzni', 'puantaj': 'Kİ'},
    {'code': 'IK', 'label': 'İş Kazası', 'puantaj': 'İK'},
    {'code': 'II', 'label': 'İdari İzin', 'puantaj': 'İİ'},
    {'code': 'SI', 'label': 'Sevk İzni', 'puantaj': 'Sİ'},
    {'code': 'B', 'label': 'Boşluk (puantaja işlenmez)', 'puantaj': ''},
]

DEFAULT_SETTINGS = {
    'kurum': {
        'il': 'ANTALYA',
        'mudurluk': 'İl Sağlık Müdürlüğü',
        'hastane': 'Demre Devlet Hastanesi',
        'birim': 'ACİL SERVİS HEKİM NÖBET',
    },
    'imza': {
        'hazirlayanBaslik': 'HAZIRLAYAN',
        'hazirlayanAd': '',
        'hazirlayanUnvan': 'ACİL SERVİS SORUMLU HEKİMİ',
        'onayBaslik': 'HARCAMA YETKİLİSİ',
        'onayAd': '',
        'onayUnvan': 'BAŞHEKİM \\ HASTANE YÖNETİCİSİ',
    },
    'excuses': DEFAULT_EXCUSES,
    'colors': {
        'excuseExcel': '#A6A6A6',   # renkli listede mazeret hücresi
        'holiday': '#D9D9D9',       # tatil / hafta sonu gölgesi
    },
    'specialistKeyword': 'uzm',     # unvanında bu geçen hekim UZM.DR. sayılır
}

PALETTE = ['#C5D3FF', '#FFD966', '#C00000', '#D81CBD', '#D490C2', '#F4B084',
           '#B889DB', '#FFD46B', '#C65911', '#33CCFF', '#FFE699', '#BDD7EE',
           '#A9D18E', '#9DC3E6']

# Eski sürümden kalan kodlar
LEGACY_CODE_MAP = {'I': 'YI', 'X': 'R'}

_TR_ALPHABET = 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ'


def tr_upper(text):
    """Türkçe büyük harf: i -> İ, ı -> I (Python'un upper() fonksiyonu bunu yanlış yapar)."""
    return (text or '').replace('i', 'İ').replace('ı', 'I').upper()


def tr_sort_key(text):
    out = []
    for ch in tr_upper(text):
        idx = _TR_ALPHABET.find(ch)
        out.append(idx if idx >= 0 else 100 + ord(ch))
    return out


def new_id():
    return 'p' + secrets.token_hex(4)


def parse_ym(ym):
    m = re.fullmatch(r'(\d{4})-(\d{2})', ym or '')
    if not m:
        raise ValueError('Geçersiz ay: %r' % ym)
    year, month = int(m.group(1)), int(m.group(2))
    if not (2000 <= year <= 2100 and 1 <= month <= 12):
        raise ValueError('Geçersiz ay: %r' % ym)
    return year, month


def days_in_month(ym):
    year, month = parse_ym(ym)
    return calendar.monthrange(year, month)[1]


def weekend_days(ym):
    year, month = parse_ym(ym)
    return [d for d in range(1, days_in_month(ym) + 1)
            if calendar.weekday(year, month, d) >= 5]


def get_month(doc, ym):
    """Ayın verisi; hiç düzenlenmemiş ayda tatiller varsayılan olarak hafta sonlarıdır."""
    month = (doc.get('months') or {}).get(ym)
    if month is None:
        return {'schedule': {}, 'holidays': weekend_days(ym)}
    return {'schedule': month.get('schedule') or {}, 'holidays': month.get('holidays') or []}


def month_physicians(doc, ym):
    """Bu ayda gösterilecek hekimler: aktif olanlar + o ayda kaydı olan pasifler (sıra korunur)."""
    schedule = get_month(doc, ym)['schedule']
    used = {key.rsplit('-', 1)[0] for key, val in schedule.items() if val}
    return [p for p in doc.get('physicians', []) if p.get('active', True) or p['id'] in used]


def is_specialist(physician, settings):
    keyword = (settings.get('specialistKeyword') or 'uzm').lower()
    return keyword in (physician.get('title') or '').lower()


def puantaj_order(physicians, settings):
    """Puantaj sırası: önce uzmanlar, sonra tabipler; her grupta Türkçe alfabetik."""
    return sorted(physicians, key=lambda p: (0 if is_specialist(p, settings) else 1,
                                             tr_sort_key(p.get('name', ''))))


def excuse_map(settings):
    return {e['code']: e for e in settings.get('excuses', [])}


def default_doc():
    return {'version': 2, 'settings': copy.deepcopy(DEFAULT_SETTINGS),
            'physicians': [], 'months': {}}


def normalize(doc):
    """Eksik alanları varsayılanlarla tamamlar (yeni ayar eklenince eski veri bozulmasın)."""
    doc = doc or default_doc()
    settings = doc.setdefault('settings', {})
    for key, val in DEFAULT_SETTINGS.items():
        if isinstance(val, dict):
            cur = settings.setdefault(key, {})
            for k2, v2 in val.items():
                cur.setdefault(k2, v2)
        else:
            settings.setdefault(key, copy.deepcopy(val))
    doc.setdefault('physicians', [])
    doc.setdefault('months', {})
    doc['version'] = 2
    for p in doc['physicians']:
        p.setdefault('active', True)
        p.setdefault('tc', '')
        p.setdefault('title', 'Dr')
        p.setdefault('displayName', p.get('name', ''))
    return doc


def migrate_legacy(old):
    """Eski (ad tabanlı, tek aylık) veriyi yeni yapıya taşır."""
    if not old:
        return default_doc()
    if old.get('version') == 2:
        return normalize(old)
    doc = default_doc()
    name_to_id = {}
    for i, p in enumerate(old.get('physicians') or []):
        pid = new_id()
        name_to_id[p.get('name', '')] = pid
        doc['physicians'].append({
            'id': pid,
            'name': p.get('name', ''),
            'displayName': p.get('displayName') or p.get('name', ''),
            'color': p.get('color') or PALETTE[i % len(PALETTE)],
            'tc': p.get('tc', ''),
            'title': p.get('title') or 'Dr',
            'active': True,
        })
    year, month = old.get('year'), old.get('month')
    if isinstance(year, int) and isinstance(month, int):
        ym = '%04d-%02d' % (year, month + 1)   # eski sürümde ay 0'dan başlıyordu
        schedule = {}
        for key, val in (old.get('schedule') or {}).items():
            if not val or '-' not in key:
                continue
            name, day = key.rsplit('-', 1)
            if name in name_to_id and day.isdigit():
                schedule['%s-%s' % (name_to_id[name], day)] = LEGACY_CODE_MAP.get(val, val)
        holidays = sorted(set(old.get('holidays') or []) | set(weekend_days(ym)))
        doc['months'][ym] = {'schedule': schedule, 'holidays': holidays}
    return doc


def physician_stats(schedule, pid, dim):
    count = hours = 0
    for day in range(1, dim + 1):
        val = schedule.get('%s-%d' % (pid, day), '')
        if val in SHIFT_HOURS:
            count += 1
            hours += SHIFT_HOURS[val]
    return count, hours


def isimler_rows(doc, ym):
    """Nöbet İsimleri listesinin satırları (ekran ve Excel aynı kuralı kullanır)."""
    year, mon = parse_ym(ym)
    month = get_month(doc, ym)
    settings = doc['settings']
    physicians = month_physicians(doc, ym)
    rows = []
    for day in range(1, days_in_month(ym) + 1):
        mesai, nobet = [], []
        for p in physicians:
            val = month['schedule'].get('%s-%d' % (p['id'], day), '')
            prefix = 'UZM.DR.' if is_specialist(p, settings) else 'DR.'
            label = prefix + p['name']
            if val == '8':
                mesai.append(label)
            elif val == '24':
                nobet.append(label)
            elif val == '16':
                nobet.append(label + '(16)')
        cols = nobet[:3] + [''] * (3 - len(nobet[:3]))
        if len(nobet) > 3:
            cols[2] = '+'.join(nobet[2:])
        rows.append({
            'day': day,
            'weekday': DAYS_TR[calendar.weekday(year, mon, day)],
            'holiday': day in month['holidays'],
            'mesai': '+'.join(mesai),
            'nobet': cols,
        })
    doctors = []
    for i, p in enumerate(physicians, 1):
        prefix = 'ACİL UZM.DR.' if is_specialist(p, settings) else 'DR.'
        doctors.append('%d.%s%s' % (i, prefix, p['name']))
    return rows, doctors
