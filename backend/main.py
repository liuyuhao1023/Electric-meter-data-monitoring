import asyncio
import json
import logging
import os
import urllib.request
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Dict, Any, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

@app.get("/")
def read_root():
    return RedirectResponse(url="/ui/index.html")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Configuration & State Management ---
CHARGERS_FILE = "chargers.json"
STATE_FILE = "chargers_state.json"
RECORDS_FILE = "chargers_records.json"
WEBHOOK_SETTINGS_FILE = "webhook_settings.json"
SECRETS_FILE = "secrets.json"
ALARM_CONFIG_FILE = "alarm_config.json"
ALARMS_FILE = "alarms.json"
ENERGY_STATS_FILE = "energy_stats.json"
SERVICE_LOGS_FILE = "service_logs.json"

DASHBOARD_LAN_URL = os.getenv("DASHBOARD_LAN_URL", "http://localhost:3004/ui/index.html")
DASHBOARD_WAN_URL = os.getenv("DASHBOARD_WAN_URL", "")

def get_dashboard_links_md():
    links = [f"[🏠 局域网访问]({DASHBOARD_LAN_URL})"]
    if DASHBOARD_WAN_URL:
        links.append(f"[🌍 外网访问]({DASHBOARD_WAN_URL})")
    return "\n".join(links)

chargers_config = {
    "charger-1": {"host": "192.168.1.100", "port": 8887, "address": "000000000001", "name": "1号充电桩"}
}
chargers_state = {}
chargers_records = {}
connected_clients = set()
polling_tasks = {}
last_result_data = {}
energy_stats = {}
service_logs = []
main_loop = None

default_webhook_settings = {
    "charge": {"key": "", "enabled": True},
    "alarm": {"key": "", "enabled": True}
}

default_alarm_config = {
    "over_voltage": 250.0,
    "under_voltage": 190.0,
    "over_current": 80.0,
    "over_power": 20.0
}
alarms_config = default_alarm_config.copy()
system_alarms = []

def load_json(filepath, default):
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load {filepath}: {e}")
    return default

def save_json(filepath, data):
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to save {filepath}: {e}")

chargers_config = load_json(CHARGERS_FILE, chargers_config)
chargers_state = load_json(STATE_FILE, {})
chargers_records = load_json(RECORDS_FILE, {})
webhook_settings = load_json(WEBHOOK_SETTINGS_FILE, default_webhook_settings)
if "webhook_key" in webhook_settings:
    old_key = webhook_settings.get("webhook_key", "")
    old_enabled = webhook_settings.get("webhook_enabled", True)
    webhook_settings = {
        "charge": {"key": old_key, "enabled": old_enabled},
        "alarm": {"key": old_key, "enabled": old_enabled}
    }
alarms_config = load_json(ALARM_CONFIG_FILE, default_alarm_config)
system_alarms = load_json(ALARMS_FILE, [])
energy_stats = load_json(ENERGY_STATS_FILE, {})
service_logs = load_json(SERVICE_LOGS_FILE, [])

admin_password = load_json(SECRETS_FILE, {"password": "123456"}).get("password", "123456")

def verify_admin(x_admin_password: str = Header(None)):
    if not x_admin_password or x_admin_password != admin_password:
        raise HTTPException(status_code=401, detail="Invalid admin password")
    return True

def init_charger_state(cid: str):
    if cid not in chargers_state:
        chargers_state[cid] = {
            "charge_state": "IDLE",
            "charge_start_time": None,
            "charge_start_energy": 0.0,
            "charge_start_tou": {},
            "max_charge_energy": 0.0,
            "max_charge_tou": {},
            "idle_counter": 0,
            "start_counter": 0,
            "baseline_current": 0.0
        }
    if cid not in chargers_records:
        chargers_records[cid] = []

    if cid not in energy_stats:
        today = datetime.now().strftime("%Y-%m-%d")
        month = datetime.now().strftime("%Y-%m")
        energy_stats[cid] = {
            "total_kwh": 0.0,
            "last_raw_kwh": None,
            "daily": {today: 0.0},
            "monthly": {month: 0.0}
        }

async def save_energy_stats_task():
    while True:
        await asyncio.sleep(60)
        save_json(ENERGY_STATS_FILE, energy_stats)

def update_energy_stats(cid, metrics):
    if cid not in energy_stats: return
    current_kwh = metrics.get("正向有功总 (kWh)")
    if current_kwh is None: return
    
    stats = energy_stats[cid]
    last_kwh = stats["last_raw_kwh"]
    stats["last_raw_kwh"] = current_kwh
    
    # end of energy_stats init
    delta = 0.0
    if last_kwh is not None:
        if current_kwh >= last_kwh:
            delta = current_kwh - last_kwh
        else:
            delta = current_kwh
            add_alarm(cid, "表底重置", "warning", f"旧:{last_kwh} 新:{current_kwh}", "检测到电表被清零或更换，能耗从新表底继续累加")
    
    if delta > 0:
        today = datetime.now().strftime("%Y-%m-%d")
        month = datetime.now().strftime("%Y-%m")
        
        stats["total_kwh"] = round(stats.get("total_kwh", 0) + delta, 2)
        
        if today not in stats["daily"]:
            stats["daily"][today] = 0.0
        stats["daily"][today] = round(stats["daily"][today] + delta, 2)
        
        if month not in stats["monthly"]:
            stats["monthly"][month] = 0.0
        stats["monthly"][month] = round(stats["monthly"][month] + delta, 2)

chargers_recharge_state = {}

def fetch_balance(raw_url, cid):
    if not raw_url: return None, None
    url = raw_url.replace("/PublicMeter/", "/PublicMeter/state_update/id/")
    try:
        req = urllib.request.Request(url, headers={"X-Requested-With": "XMLHttpRequest"})
        resp = urllib.request.urlopen(req, timeout=3)
        data = json.loads(resp.read().decode('utf-8'))
        if data.get("state") == "success" and "info" in data and "dashboard" in data["info"]:
            val = data["info"]["dashboard"].get("value", 0)
            using = data["info"]["dashboard"].get("using", 0)
            add_service_log(cid, "成功", f"抓取到余额: {val}元")
            return val, using
        else:
            add_service_log(cid, "失败", f"接口返回格式异常")
    except Exception as e:
        logger.error(f"Failed to fetch balance: {e}")
        add_service_log(cid, "失败", f"超时或报错: {e}")
    return None, None

def check_recharge(cid, raw_url):
    val, using = fetch_balance(raw_url, cid)
    if val is None: return
    
    if cid not in chargers_recharge_state:
        chargers_recharge_state[cid] = {"balance": val, "using": using}
        return
        
    last_state = chargers_recharge_state[cid]
    # Handle legacy state where it was just a float
    if not isinstance(last_state, dict):
        last_state = {"balance": last_state, "using": 0}
        
    last_val = last_state["balance"]
    last_using = last_state["using"]
    
    if val > last_val:
        # Ignore increase if it's a refund (using transitioned from 1 to 0)
        # Also ignore if it was a refund that happened while we didn't track using properly
        if last_using == 1 and using == 0:
            logger.info(f"{cid} refund detected, ignoring top-up alert.")
        else:
            diff = round(val - last_val, 2)
            cname = chargers_config.get(cid, {}).get("name", cid)
            msg = f"{cname}充值{diff}元"
            send_wechat_webhook(msg, "text", "charge")
            
            # Save the recharge event for the next charging session record
            if cid not in chargers_state:
                chargers_state[cid] = {}
            chargers_state[cid]["last_recharge"] = {
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "amount": diff
            }
            save_json(STATE_FILE, chargers_state)
            
    chargers_recharge_state[cid] = {"balance": val, "using": using}

async def poll_recharge_status_task():
    counter = 0
    while True:
        for cid, config in chargers_config.items():
            url = config.get("monitor_url")
            if not url: continue
            
            st = chargers_state.get(cid, {})
            state = st.get("charge_state", "IDLE")
            
            # 活跃状态（充电中/待机中）每60秒抓取一次；闲置状态每 3*60=180秒 (3分钟) 抓取一次
            if state != "IDLE" or counter % 3 == 0:
                await asyncio.to_thread(check_recharge, cid, url)
                
        await asyncio.sleep(60)
        counter += 1

async def broadcast_alarm(alarm):
    dead = set()
    for ws in list(connected_clients):
        try: await asyncio.wait_for(ws.send_json({"type": "alarm", "alarm": alarm}), timeout=1.5)
        except: dead.add(ws)
    for ws in dead: connected_clients.discard(ws)

async def broadcast_service_log(log_entry):
    dead = set()
    for ws in list(connected_clients):
        try: await asyncio.wait_for(ws.send_json({"type": "service_log", "log": log_entry}), timeout=1.5)
        except: dead.add(ws)
    for ws in dead: connected_clients.discard(ws)

def add_alarm(cid, alarm_type, level, value, message):
    alarm = {
        "id": int(datetime.now().timestamp() * 1000),
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "charger_id": cid,
        "type": alarm_type,
        "level": level,
        "value": value,
        "message": message
    }
    system_alarms.insert(0, alarm)
    if len(system_alarms) > 500:
        system_alarms.pop()
    save_json(ALARMS_FILE, system_alarms)
    asyncio.create_task(broadcast_alarm(alarm))

def add_service_log(cid, status, message):
    log_entry = {
        "id": int(datetime.now().timestamp() * 1000),
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "charger_id": cid,
        "status": status,
        "message": message
    }
    service_logs.insert(0, log_entry)
    if len(service_logs) > 500:
        service_logs.pop()
    save_json(SERVICE_LOGS_FILE, service_logs)
    if main_loop:
        asyncio.run_coroutine_threadsafe(broadcast_service_log(log_entry), main_loop)

for cid in chargers_config:
    init_charger_state(cid)

def send_wechat_webhook(content: str, msgtype: str = "text", category: str = "alarm"):
    import urllib.request
    settings = webhook_settings.get(category, {})
    if not settings.get("enabled", False): return
    key = settings.get("key", "")
    if not key: return
    try:
        url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + key
        req = urllib.request.Request(url, method="POST")
        req.add_header('Content-Type', 'application/json')
        payload = {"msgtype": msgtype}
        payload[msgtype] = {"content": content}
        data = json.dumps(payload).encode('utf-8')
        urllib.request.urlopen(req, data=data, timeout=3)
    except Exception as e:
        logger.error(f"Webhook failed: {e}")

# DL/T645-2007 Helpers
def bcd_encode(val_str, length):
    val_str = val_str.zfill(length * 2)
    return bytes.fromhex(val_str)[::-1]

def make_dlt645_request(address_str, di_hex):
    addr_bytes = bcd_encode(address_str, 6)
    di_bytes = bytes.fromhex(di_hex)[::-1]
    di_plus_33 = bytes([(b + 0x33) & 0xFF for b in di_bytes])
    frame = bytearray([0x68]) + addr_bytes + bytearray([0x68, 0x11, 0x04]) + di_plus_33
    cs = sum(frame) & 0xFF
    frame.append(cs)
    frame.append(0x16)
    return bytearray([0xFE, 0xFE, 0xFE, 0xFE]) + frame

def parse_dlt645_response(response, di_hex):
    if len(response) < 14: return None, "返回数据过短"
    start_idx = response.find(0x68)
    if start_idx == -1: return None, "未找到起始符 68"
    frame = response[start_idx:]
    if len(frame) < 14: return None, "数据帧不完整"
    if frame[7] != 0x68: return None, "数据帧格式错误"
    ctrl_code = frame[8]
    if ctrl_code == 0xD1: return None, f"电表返回异常代码: {frame[10] - 0x33:02X}"
    if ctrl_code != 0x91: return None, f"不支持的控制码: {ctrl_code:02X}"
    L = frame[9]
    if len(frame) < 10 + L + 2: return None, "数据域长度不足"
    data_region = frame[10:10+L]
    data_minus_33 = bytes([(b - 0x33) & 0xFF for b in data_region])
    resp_di = data_minus_33[0:4][::-1].hex().upper()
    if resp_di != di_hex.upper(): return None, f"数据标识不匹配"
    data_val_bytes = data_minus_33[4:]
    data_hex = data_val_bytes[::-1].hex()
    
    if di_hex.startswith("00"): return float(data_hex) / 100.0, None
    elif di_hex.startswith("0201"): return float(data_hex) / 10.0, None
    elif di_hex.startswith("0202"): return float(data_hex) / 1000.0, None
    elif di_hex.startswith("0203"): return float(data_hex) / 10000.0, None
    elif di_hex.startswith("0206"): return float(data_hex) / 1000.0, None
    elif di_hex.startswith("0400010C"):
        if len(data_hex) == 12:
            return f"20{data_hex[0:2]}-{data_hex[2:4]}-{data_hex[4:6]} {data_hex[6:8]}:{data_hex[8:10]}:{data_hex[10:12]}", None
        elif len(data_hex) == 14:
            return f"20{data_hex[0:2]}-{data_hex[2:4]}-{data_hex[4:6]} {data_hex[8:10]}:{data_hex[10:12]}:{data_hex[12:14]}", None
        return data_hex, None
    return data_hex, None

async def poll_meter_data(charger_id: str):
    logger.info(f"Starting polling for {charger_id}")
    reader, writer = None, None
    
    while True:
        if charger_id not in chargers_config:
            logger.info(f"Charger {charger_id} removed, stopping polling.")
            break
            
        settings = chargers_config[charger_id]
        st = chargers_state[charger_id]
        cname = settings.get("name", charger_id)
        
        result_data = {
            "type": "realtime",
            "charger_id": charger_id,
            "status": "error",
            "message": "未知错误",
            "address": settings["address"],
            "metrics": {},
            "charge_state": st["charge_state"]
        }
        
        try:
            if reader is None or writer is None:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(settings["host"], settings["port"]), 
                    timeout=3.0
                )
            
            queries = {
                "00010000": "正向有功总 (kWh)",
                "00010100": "正向有功-尖 (kWh)",
                "00010200": "正向有功-峰 (kWh)",
                "00010300": "正向有功-平 (kWh)",
                "00010400": "正向有功-谷 (kWh)",
                "00020000": "反向有功总 (kWh)",
                "02010100": "A相电压 (V)",
                "02010200": "B相电压 (V)",
                "02010300": "C相电压 (V)",
                "02020100": "A相电流 (A)",
                "02020200": "B相电流 (A)",
                "02020300": "C相电流 (A)",
                "02030000": "总有功功率 (kW)",
                "02060000": "总功率因数",
                "0400010C": "电表时间"
            }
            
            metrics = {}
            raw_metrics = {}
            success = True
            err_msg = ""
            
            for di, name in queries.items():
                metric_success = False
                for attempt in range(3):
                    try:
                        while True:
                            reader._buffer.clear()
                            break
                    except: pass
                    req = make_dlt645_request(settings["address"], di)
                    writer.write(req)
                    await asyncio.wait_for(writer.drain(), timeout=2.0)
                    try:
                        resp = await asyncio.wait_for(reader.read(1024), timeout=2.5)
                        if not resp:
                            err_msg = "电表无响应"
                            await asyncio.sleep(1.0)
                            continue
                        val, err = parse_dlt645_response(resp, di)
                        if err:
                            err_msg = err
                            await asyncio.sleep(1.0)
                            continue
                        
                        raw_metrics[name] = val
                        ct_ratio = float(settings.get("ct_ratio", 20 if "a" in charger_id.lower() else 1))
                        if isinstance(val, (int, float)):
                            if ("电流" in name or ("功率" in name and "因数" not in name) or "有功" in name) and ct_ratio > 1:
                                val = round(val * ct_ratio, 2)
                            else:
                                val = round(val, 2)
                        metrics[name] = val
                        metric_success = True
                        await asyncio.sleep(0.5)
                        break
                    except asyncio.TimeoutError:
                        err_msg = "读取超时"
                        await asyncio.sleep(1.0)
                        continue
                if not metric_success:
                    if di == "0400010C":
                        continue
                    success = False
                    break
            
            if not success:
                st["offline_counter"] = st.get("offline_counter", 0) + 1
                if st["offline_counter"] == 3:
                    add_alarm(charger_id, "离线", "error", "", err_msg)
                raise Exception(err_msg)
            
            if st.get("offline_counter", 0) >= 3:
                add_alarm(charger_id, "恢复上线", "info", "", "电表已恢复通讯")
            st["offline_counter"] = 0
            
            # --- Alarm Engine ---
            v_a, v_b, v_c = metrics.get("A相电压 (V)", 0), metrics.get("B相电压 (V)", 0), metrics.get("C相电压 (V)", 0)
            if v_a > alarms_config["over_voltage"] or v_b > alarms_config["over_voltage"] or v_c > alarms_config["over_voltage"]:
                add_alarm(charger_id, "过压", "warning", f"A:{v_a} B:{v_b} C:{v_c}", "电压超过预警上限")
            if (0 < v_a < alarms_config["under_voltage"]) or (0 < v_b < alarms_config["under_voltage"]) or (0 < v_c < alarms_config["under_voltage"]):
                add_alarm(charger_id, "欠压", "warning", f"A:{v_a} B:{v_b} C:{v_c}", "电压低于预警下限")
                
            current_a = metrics.get("A相电流 (A)", 0.0)
            current_b = metrics.get("B相电流 (A)", 0.0)
            current_c = metrics.get("C相电流 (A)", 0.0)
            max_current = max(current_a, current_b, current_c)
            if max_current > alarms_config["over_current"]:
                add_alarm(charger_id, "过流", "error", f"{max_current}A", "电流超过告警阈值")
                
            total_power = metrics.get("总有功功率 (kW)", 0.0)
            if total_power > alarms_config["over_power"]:
                add_alarm(charger_id, "功率异常", "warning", f"{total_power}kW", "总功率超出设定阈值")
            
            # --- Charging State Logic ---
            total_energy = metrics.get("正向有功总 (kWh)", 0.0)
            update_energy_stats(charger_id, metrics)
            
            if st["charge_state"] == "IDLE":
                if max_current > 4.0:
                    st["start_counter"] += 1
                    save_json(STATE_FILE, chargers_state)
                    if st["start_counter"] >= 3:
                        st["charge_state"] = "CHARGING"
                        st["start_counter"] = 0
                        st["idle_counter"] = 0
                        st["charge_start_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        st["charge_start_energy"] = total_energy
                        st["charge_start_tou"] = {
                            "尖": metrics.get("正向有功-尖 (kWh)", 0.0),
                            "峰": metrics.get("正向有功-峰 (kWh)", 0.0),
                            "平": metrics.get("正向有功-平 (kWh)", 0.0),
                            "谷": metrics.get("正向有功-谷 (kWh)", 0.0)
                        }
                        st["max_charge_energy"] = total_energy
                        st["max_charge_tou"] = dict(st["charge_start_tou"])
                        save_json(STATE_FILE, chargers_state)
                        
                        logger.info(f"{cname} Charging started at {st['charge_start_time']}")
                        dt_start = datetime.strptime(st['charge_start_time'], "%Y-%m-%d %H:%M:%S")
                        time_str = f"{dt_start.month}月{dt_start.day}日{dt_start.hour}时{dt_start.minute}分"
                        text_msg = f"{cname}于{time_str}开始充电"
                        asyncio.create_task(asyncio.to_thread(send_wechat_webhook, text_msg, "text", "charge"))
                        md_msg = f"# ⚡ {cname}充电通知\n> **{cname}于{time_str}开始充电**\n> **初始表数**: {total_energy} kWh\n\n{get_dashboard_links_md()}"
                        asyncio.create_task(asyncio.to_thread(send_wechat_webhook, md_msg, "markdown", "charge"))
                elif max_current >= 0.5:
                    st["start_counter"] += 1
                    save_json(STATE_FILE, chargers_state)
                    if st["start_counter"] >= 3:
                        st["charge_state"] = "STANDBY"
                        st["baseline_current"] = max_current
                        st["start_counter"] = 0
                        st["idle_counter"] = 0
                        save_json(STATE_FILE, chargers_state)
                        logger.info(f"{cname} Entered STANDBY mode ({max_current}A)")
                        
                        monitor_url = settings.get("monitor_url")
                        if monitor_url:
                            asyncio.create_task(asyncio.to_thread(check_recharge, charger_id, monitor_url))
                else:
                    if st["start_counter"] > 0:
                        st["start_counter"] = 0
                        save_json(STATE_FILE, chargers_state)
                        
            elif st["charge_state"] == "STANDBY":
                # Check if it drops back to IDLE (e.g. top-up expired without plugging in)
                if max_current < 0.5:
                    st["idle_counter"] += 1
                    save_json(STATE_FILE, chargers_state)
                    if st["idle_counter"] >= 3:
                        st["charge_state"] = "IDLE"
                        st["idle_counter"] = 0
                        st["start_counter"] = 0
                        st["baseline_current"] = 0.0
                        save_json(STATE_FILE, chargers_state)
                        
                        # Hardware trigger: relay opened, refund processed
                        monitor_url = settings.get("monitor_url")
                        if monitor_url:
                            asyncio.create_task(asyncio.to_thread(check_recharge, charger_id, monitor_url))
                # Check if it rises above baseline to CHARGING
                elif max_current > st.get("baseline_current", 0.0) + 1.0 or max_current > 4.0:
                    st["start_counter"] += 1
                    save_json(STATE_FILE, chargers_state)
                    if st["start_counter"] >= 3:
                        st["charge_state"] = "CHARGING"
                        st["start_counter"] = 0
                        st["idle_counter"] = 0
                        st["charge_start_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        st["charge_start_energy"] = total_energy
                        st["charge_start_tou"] = {
                            "尖": metrics.get("正向有功-尖 (kWh)", 0.0),
                            "峰": metrics.get("正向有功-峰 (kWh)", 0.0),
                            "平": metrics.get("正向有功-平 (kWh)", 0.0),
                            "谷": metrics.get("正向有功-谷 (kWh)", 0.0)
                        }
                        st["max_charge_energy"] = total_energy
                        st["max_charge_tou"] = dict(st["charge_start_tou"])
                        save_json(STATE_FILE, chargers_state)
                        
                        logger.info(f"{cname} Charging started at {st['charge_start_time']}")
                        dt_start = datetime.strptime(st['charge_start_time'], "%Y-%m-%d %H:%M:%S")
                        time_str = f"{dt_start.month}月{dt_start.day}日{dt_start.hour}时{dt_start.minute}分"
                        text_msg = f"{cname}开始充电"
                        asyncio.create_task(asyncio.to_thread(send_wechat_webhook, text_msg, "text", "charge"))
                        md_msg = f"# ⚡ {cname}充电通知\n> **{cname}开始充电**\n> **初始表数**: {total_energy} kWh\n\n{get_dashboard_links_md()}"
                        asyncio.create_task(asyncio.to_thread(send_wechat_webhook, md_msg, "markdown", "charge"))
                else:
                    # Maintain baseline, reset counters
                    if st["start_counter"] > 0 or st["idle_counter"] > 0:
                        st["start_counter"] = 0
                        st["idle_counter"] = 0
                        save_json(STATE_FILE, chargers_state)
                    
            elif st["charge_state"] == "CHARGING":
                st["max_charge_energy"] = max(st["max_charge_energy"], total_energy)
                for key in ["尖", "峰", "平", "谷"]:
                    st["max_charge_tou"][key] = max(st.get("max_charge_tou", {}).get(key, 0.0), metrics.get(f"正向有功-{key} (kWh)", 0.0))
                save_json(STATE_FILE, chargers_state)
                
                # Check if charging stopped (current drops near or below baseline, or below 3.5A fallback)
                if max_current < max(st.get("baseline_current", 0.0) + 0.5, 3.5):
                    st["idle_counter"] += 1
                    save_json(STATE_FILE, chargers_state)
                    if st["idle_counter"] >= 3:
                        # Drop back to STANDBY if still above 0.5, else IDLE
                        if max_current >= 0.5:
                            st["charge_state"] = "STANDBY"
                            st["baseline_current"] = max_current
                        else:
                            st["charge_state"] = "IDLE"
                            st["baseline_current"] = 0.0
                            
                        st["idle_counter"] = 0
                        st["start_counter"] = 0
                        end_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        consumed = st["max_charge_energy"] - st["charge_start_energy"]
                        if consumed < 0: consumed = 0
                        
                        tou_consumed = {}
                        if st.get("charge_start_tou"):
                            for key in ["尖", "峰", "平", "谷"]:
                                start_val = st["charge_start_tou"].get(key, 0.0)
                                val = st["max_charge_tou"].get(key, 0.0) - start_val
                                tou_consumed[key] = round(val if val > 0 else 0, 2)
                        
                        
                        recharge_info = st.get("last_recharge", {})
                        
                        record = {
                            "id": len(chargers_records[charger_id]) + 1,
                            "recharge_time": recharge_info.get("time", "-"),
                            "recharge_amount": recharge_info.get("amount", "-"),
                            "start_time": st["charge_start_time"],
                            "end_time": end_time,
                            "start_energy": st["charge_start_energy"],
                            "end_energy": st["max_charge_energy"],
                            "consumed_kwh": round(consumed, 2),
                            "tou": tou_consumed
                        }
                        
                        # Clear last_recharge so it's not reused for the next session
                        if "last_recharge" in st:
                            del st["last_recharge"]
                            
                        chargers_records[charger_id].insert(0, record)
                        save_json(RECORDS_FILE, chargers_records)
                        save_json(STATE_FILE, chargers_state)
                        logger.info(f"{cname} Charging stopped.")
                        dt_end = datetime.strptime(end_time, "%Y-%m-%d %H:%M:%S")
                        time_str_end = f"{dt_end.month}月{dt_end.day}日{dt_end.hour}时{dt_end.minute}分"
                        
                        balance_text = ""
                        monitor_url = settings.get("monitor_url")
                        if monitor_url:
                            try:
                                final_balance, final_using = await asyncio.to_thread(fetch_balance, monitor_url, charger_id)
                                if final_balance is not None:
                                    balance_text = f"余额还剩{final_balance}元"
                                    # Update baseline to prevent double-counting if the refund hasn't happened yet
                                    if charger_id in chargers_recharge_state and isinstance(chargers_recharge_state[charger_id], dict):
                                        chargers_recharge_state[charger_id]["balance"] = final_balance
                                        chargers_recharge_state[charger_id]["using"] = final_using
                            except Exception as e:
                                logger.error(f"Failed to fetch final balance: {e}")
                                
                        text_msg = f"{cname}于{time_str_end}结束充电，本次充电总用电量为：{round(consumed, 2)}度。{balance_text}"
                        asyncio.create_task(asyncio.to_thread(send_wechat_webhook, text_msg, "text", "charge"))
                        md_msg_end = f"# 🛑 {cname}停机通知\n> **{text_msg}**\n\n{get_dashboard_links_md()}"
                        asyncio.create_task(asyncio.to_thread(send_wechat_webhook, md_msg_end, "markdown", "charge"))
                        
                        for ws in list(connected_clients):
                            try: await asyncio.wait_for(ws.send_json({"type": "new_record", "charger_id": charger_id, "record": record}), timeout=1.5)
                            except: pass
                else:
                    if st["idle_counter"] > 0:
                        st["idle_counter"] = 0
                        save_json(STATE_FILE, chargers_state)

            result_data = {
                "type": "realtime",
                "charger_id": charger_id,
                "status": "success",
                "address": settings["address"],
                "metrics": metrics,
                "raw_metrics": raw_metrics,
                "charge_state": st["charge_state"],
                "start_counter": st["start_counter"],
                "idle_counter": st["idle_counter"],
                "ct_ratio": settings.get("ct_ratio", 20 if "a" in charger_id.lower() else 1),
                "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "energy_stats": energy_stats.get(charger_id, {}),
                "balance": chargers_recharge_state.get(charger_id, {}).get("balance") if isinstance(chargers_recharge_state.get(charger_id), dict) else chargers_recharge_state.get(charger_id)
            }
        except Exception as e:
            result_data = {
                "type": "realtime", 
                "charger_id": charger_id, 
                "status": "error", 
                "message": str(e),
                "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
            if writer:
                try:
                    writer.close()
                    await asyncio.wait_for(writer.wait_closed(), timeout=1.0)
                except: pass
            reader, writer = None, None
            
        last_result_data[charger_id] = result_data
            
        dead_clients = set()
        for ws in list(connected_clients):
            try: await asyncio.wait_for(ws.send_json(result_data), timeout=1.5)
            except: dead_clients.add(ws)
        for ws in dead_clients:
            connected_clients.discard(ws)
            
        if st["charge_state"] == "IDLE":
            await asyncio.sleep(2)
        else:
            await asyncio.sleep(2)

async def supervisor_task():
    while True:
        await asyncio.sleep(5)
        for cid in list(chargers_config.keys()):
            task = polling_tasks.get(cid)
            if task is None or task.done():
                if task and task.done() and not task.cancelled():
                    exc = task.exception()
                    if exc:
                        logger.error(f"Polling task for {cid} stopped with exception: {exc}, auto-restarting...")
                logger.info(f"Supervisor: auto-restarting polling task for {cid}")
                polling_tasks[cid] = asyncio.create_task(poll_meter_data(cid))

@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()
    asyncio.create_task(save_energy_stats_task())
    asyncio.create_task(poll_recharge_status_task())
    asyncio.create_task(supervisor_task())
    for cid in chargers_config:
        task = asyncio.create_task(poll_meter_data(cid))
        polling_tasks[cid] = task

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    for cid, data in last_result_data.items():
        try: await asyncio.wait_for(websocket.send_json(data), timeout=1.5)
        except: pass
    try:
        while True: await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(websocket)

@app.get("/api/alarms")
def get_alarms():
    return system_alarms

@app.get("/api/alarms/config")
def get_alarms_config():
    return alarms_config

@app.get("/api/energy_stats")
def get_energy_stats_api():
    return energy_stats

class AlarmConfigModel(BaseModel):
    over_voltage: float
    under_voltage: float
    over_current: float
    over_power: float

@app.post("/api/alarms/config")
def update_alarms_config(body: AlarmConfigModel, _: bool = Depends(verify_admin)):
    global alarms_config
    alarms_config = {
        "over_voltage": body.over_voltage,
        "under_voltage": body.under_voltage,
        "over_current": body.over_current,
        "over_power": body.over_power
    }
    save_json(ALARM_CONFIG_FILE, alarms_config)
    return {"status": "ok"}

@app.get("/api/chargers")
def get_chargers():
    return chargers_config

class ChargerConfigModel(BaseModel):
    host: str
    port: int
    address: str
    name: str
    ct_ratio: int = 1
    location: Optional[str] = ""
    sn: Optional[str] = ""
    protocol: Optional[str] = "DL/T645-2007"
    remarks: Optional[str] = ""
    monitor_url: Optional[str] = ""

@app.post("/api/chargers/{charger_id}")
async def update_charger(charger_id: str, body: ChargerConfigModel, _: bool = Depends(verify_admin)):
    chargers_config[charger_id] = {
        "host": body.host,
        "port": body.port,
        "address": body.address.upper(),
        "name": body.name,
        "ct_ratio": body.ct_ratio,
        "location": body.location,
        "sn": body.sn,
        "protocol": body.protocol,
        "remarks": body.remarks,
        "monitor_url": body.monitor_url
    }
    save_json(CHARGERS_FILE, chargers_config)
    init_charger_state(charger_id)
    if charger_id in polling_tasks:
        polling_tasks[charger_id].cancel()
    task = asyncio.create_task(poll_meter_data(charger_id))
    polling_tasks[charger_id] = task
    return {"status": "ok"}

@app.delete("/api/chargers/{charger_id}")
async def delete_charger(charger_id: str, _: bool = Depends(verify_admin)):
    if charger_id in chargers_config:
        del chargers_config[charger_id]
        save_json(CHARGERS_FILE, chargers_config)
    if charger_id in polling_tasks:
        polling_tasks[charger_id].cancel()
        del polling_tasks[charger_id]
    return {"status": "ok"}

@app.get("/api/records/{charger_id}")
def get_records(charger_id: str):
    return chargers_records.get(charger_id, [])

@app.get("/api/all_records")
def get_all_records():
    all_recs = []
    for cid, recs in chargers_records.items():
        cname = chargers_config.get(cid, {}).get("name", cid)
        for r in recs:
            # Create a copy so we don't mutate the stored record
            r_copy = dict(r)
            r_copy["charger_id"] = cid
            r_copy["charger_name"] = cname
            all_recs.append(r_copy)
    # Sort by end_time descending
    all_recs.sort(key=lambda x: x.get("end_time", ""), reverse=True)
    return all_recs

class WebhookSettingsModel(BaseModel):
    charge: dict
    alarm: dict

@app.get("/api/webhook-settings")
def get_webhook_settings():
    return webhook_settings

@app.post("/api/webhook-settings")
def update_webhook_settings(body: WebhookSettingsModel, _: bool = Depends(verify_admin)):
    global webhook_settings
    webhook_settings["charge"] = {"key": body.charge.get("key", "").strip(), "enabled": body.charge.get("enabled", True)}
    webhook_settings["alarm"] = {"key": body.alarm.get("key", "").strip(), "enabled": body.alarm.get("enabled", True)}
    save_json(WEBHOOK_SETTINGS_FILE, webhook_settings)
    return {"status": "ok", "settings": webhook_settings}

class PasswordChangeModel(BaseModel):
    old_password: str
    new_password: str

@app.post("/api/admin/password")
def change_password(body: PasswordChangeModel):
    global admin_password
    if body.old_password != admin_password:
        raise HTTPException(status_code=401, detail="旧密码错误")
    if len(body.new_password) < 1:
        raise HTTPException(status_code=400, detail="新密码不能为空")
    admin_password = body.new_password
    save_json(SECRETS_FILE, {"password": admin_password})
    return {"status": "ok"}

@app.get("/api/service_logs")
def get_service_logs():
    return service_logs

frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if not os.path.exists(frontend_dir):
    frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
if os.path.exists(frontend_dir):
    app.mount("/ui", StaticFiles(directory=frontend_dir, html=True), name="frontend")
