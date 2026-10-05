document.addEventListener('DOMContentLoaded', () => {
    const hostName = window.location.hostname || 'localhost';
    const portName = window.location.port || '8000';
    const wsUrl = `ws://${hostName}:${portName}/ws`;
    const apiUrl = `http://${hostName}:${portName}/api`;
    let ws;
    
    const connectionLed = document.getElementById('connection-led');
    const connectionText = document.getElementById('connection-text');
    
    // Navigation Routing Logic
    const navItems = document.querySelectorAll('.nav-item');
    const viewContainers = document.querySelectorAll('.view-container');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            viewContainers.forEach(view => view.style.display = 'none');
            const targetViewId = item.getAttribute('data-view');
            const targetView = document.getElementById(targetViewId);
            if (targetView) targetView.style.display = 'block';
            if (targetViewId === 'view-current-overload' && typeof loadOverloadRules === 'function') {
                loadOverloadRules();
            }
        });
    });
    // Auth Modal Logic
    const authModal = document.getElementById('auth-modal');
    const authPassword = document.getElementById('auth-password');
    const authCancel = document.getElementById('auth-cancel');
    const authConfirm = document.getElementById('auth-confirm');
    const authError = document.getElementById('auth-error');
    let pendingAuthCallback = null;

    function withAuth(callback) {
        pendingAuthCallback = callback;
        authPassword.value = '';
        authError.classList.add('hidden');
        authModal.style.display = 'flex';
        authPassword.focus();
    }

    function closeAuth() {
        authModal.style.display = 'none';
        pendingAuthCallback = null;
    }

    authCancel.addEventListener('click', closeAuth);
    authConfirm.addEventListener('click', () => {
        const pwd = authPassword.value;
        if (!pwd) {
            authError.textContent = "请输入密码";
            authError.classList.remove('hidden');
            return;
        }
        if (pendingAuthCallback) {
            // We pass the password to the callback, it will decide if it's correct via the API
            const cb = pendingAuthCallback;
            pendingAuthCallback = null;
            authModal.style.display = 'none';
            cb(pwd);
        }
    });

    // Configuration Logic
    const configFormsWrapper = document.getElementById('charger-forms-wrapper');
    const addChargerBtn = document.getElementById('add-charger-btn');
    let chargersConfig = {};
    let lastData = {};

    function loadSettings() {
        fetch(`${apiUrl}/chargers`)
            .then(res => res.json())
            .then(data => {
                chargersConfig = data;
                renderConfigForms();
                if (typeof renderOverloadView === 'function') renderOverloadView();
                if (!ws) connect();
            })
            .catch(err => console.error("Could not load chargers settings:", err));
    }

    function renderConfigForms() {
        configFormsWrapper.innerHTML = '';
        for (const [cid, config] of Object.entries(chargersConfig)) {
            configFormsWrapper.appendChild(createConfigForm(cid, config));
            
            // Update the CT Ratio badge in the view
            const view = document.getElementById(`view-${cid}`);
            if (view) {
                const badge = view.querySelector('.ct-badge');
                if (badge) {
                    const ratio = config.ct_ratio !== undefined ? config.ct_ratio : (cid === 'charger-a' ? 20 : 1);
                    if (ratio > 1) {
                        badge.textContent = `已启用 ${ratio} 倍互感器换算`;
                        badge.style.display = 'inline-block';
                    } else {
                        badge.style.display = 'none';
                    }
                }
            }
        }
        renderMeterTable();
        renderSerialServersTable();
    }

    function createConfigForm(cid, config) {
        const div = document.createElement('div');
        div.className = 'form-grid';
        div.style.background = 'rgba(255,255,255,0.05)';
        div.style.padding = '1rem';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid rgba(255,255,255,0.1)';
        
        div.innerHTML = `
            <div class="input-group" style="grid-column: 1 / -1; margin-bottom: 0;">
                <h3 style="color: var(--primary); margin: 0;">${config.name || cid} <span style="font-size: 0.8rem; color: #888;">(${cid})</span></h3>
            </div>
            <div class="input-group">
                <label>目标充电桩 (ID)</label>
                <input type="text" class="inp-cid" value="${cid}" readonly style="background: rgba(0,0,0,0.2); color: #888;">
            </div>
            <div class="input-group">
                <label>充电桩名称</label>
                <input type="text" class="inp-name" value="${config.name || cid}">
            </div>
            <div class="input-group">
                <label>串口服务器 IP</label>
                <input type="text" class="inp-host" value="${config.host || ''}">
            </div>
            <div class="input-group">
                <label>端口号</label>
                <input type="number" class="inp-port" value="${config.port || 8887}">
            </div>
            <div class="input-group">
                <label>电表地址 (12位)</label>
                <input type="text" class="inp-address" value="${config.address || ''}">
            </div>
            <div class="input-group">
                <label>互感器倍数 (直连表填 1)</label>
                <input type="number" class="inp-ct" value="${config.ct_ratio !== undefined ? config.ct_ratio : (cid === 'charger-a' ? 20 : 1)}">
            </div>
            <div class="input-group" style="grid-column: 1 / -1;">
                <label>第三方充值监控链接 (可选)</label>
                <input type="text" class="inp-monitor-url" placeholder="例如: http://wx.tqdianbiao.com/PublicMeter/..." value="${config.monitor_url || ''}">
            </div>
            <div class="input-group" style="grid-column: 1 / -1; display: flex; flex-direction: row; gap: 0.5rem; justify-content: flex-end;">
                <button class="btn-primary delete-btn" style="background: rgba(255, 50, 50, 0.2); color: #ff5555; border: 1px solid #ff5555;">删除</button>
                <button class="btn-primary save-btn">保存并连接</button>
            </div>
            <div class="error-banner hidden" style="grid-column: 1 / -1; margin-top: 0.5rem;"></div>
        `;

        const saveBtn = div.querySelector('.save-btn');
        const errorBanner = div.querySelector('.error-banner');

        saveBtn.addEventListener('click', () => {
            const newCid = div.querySelector('.inp-cid').value.trim();
            const newName = div.querySelector('.inp-name').value.trim();
            let addr = div.querySelector('.inp-address').value.trim().toUpperCase();
            
            if (addr.length !== 12 && addr.length > 0) {
                errorBanner.textContent = "电表地址必须是 12 位数字或 AAAAAAAAAAAA";
                errorBanner.classList.remove('hidden');
                return;
            }

            const payload = {
                host: div.querySelector('.inp-host').value.trim(),
                port: parseInt(div.querySelector('.inp-port').value),
                address: addr,
                name: newName,
                ct_ratio: parseInt(div.querySelector('.inp-ct').value) || 1,
                monitor_url: div.querySelector('.inp-monitor-url').value.trim()
            };

            withAuth((pwd) => {
                fetch(`${apiUrl}/chargers/${newCid}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-admin-password': pwd },
                    body: JSON.stringify(payload)
                }).then(async r => {
                    const res = await r.json();
                    if (r.status === 401) {
                        alert("验证失败：" + res.detail);
                        return;
                    }
                    if(res.status === 'ok') {
                        errorBanner.classList.add('hidden');
                        alert(`${newName} 配置已保存，后台已尝试连接！`);
                        loadSettings();
                        
                        const view = document.getElementById(`view-${newCid}`);
                        if (view) {
                            const dataGrid = view.querySelector('.data-grid');
                            const emptyState = view.querySelector('.empty-state');
                            if (dataGrid) dataGrid.innerHTML = '';
                            if (emptyState) emptyState.style.display = 'flex';
                        }
                    }
                });
            });
        });

        const deleteBtn = div.querySelector('.delete-btn');

        deleteBtn.addEventListener('click', () => {
            const currentCid = div.querySelector('.inp-cid').value.trim();
            if (confirm(`确定要删除 [${currentCid}] 这个充电桩配置吗？`)) {
                withAuth((pwd) => {
                    fetch(`${apiUrl}/chargers/${currentCid}`, {
                        method: 'DELETE',
                        headers: { 'x-admin-password': pwd }
                    }).then(async r => {
                        if (r.status === 401) {
                            alert("验证失败：权限不足");
                            return;
                        }
                        const res = await r.json();
                        if (res.status === 'ok') {
                            delete chargersConfig[currentCid];
                            renderConfigForms();
                        }
                    }).catch(err => {
                        delete chargersConfig[currentCid];
                        renderConfigForms();
                    });
                });
            }
        });

        return div;
    }

    // Add Charger Modal Logic
    const addChargerModal = document.getElementById('add-charger-modal');
    const addChargerSelect = document.getElementById('add-charger-select');
    const addChargerError = document.getElementById('add-charger-error');
    const addChargerCancel = document.getElementById('add-charger-cancel');
    const addChargerConfirm = document.getElementById('add-charger-confirm');

    const ALL_CHARGERS = {
        'charger-mid': '中间充电桩',
        'charger-a': 'A枪充电桩',
        'charger-b': 'B枪充电桩'
    };

    addChargerBtn.addEventListener('click', () => {
        addChargerSelect.innerHTML = '';
        let hasAvailable = false;
        for (const [cid, name] of Object.entries(ALL_CHARGERS)) {
            if (!chargersConfig[cid]) {
                const opt = document.createElement('option');
                opt.value = cid;
                opt.textContent = name;
                addChargerSelect.appendChild(opt);
                hasAvailable = true;
            }
        }

        if (!hasAvailable) {
            alert("所有的充电桩都已经配置过了！");
            return;
        }

        addChargerError.classList.add('hidden');
        addChargerModal.style.display = 'flex';
    });

    addChargerCancel.addEventListener('click', () => {
        addChargerModal.style.display = 'none';
    });

    addChargerConfirm.addEventListener('click', () => {
        const newCid = addChargerSelect.value;
        if (!newCid) return;
        const newName = ALL_CHARGERS[newCid];
        
        chargersConfig[newCid] = { host: "192.168.1.100", port: 8887, address: "", name: newName, ct_ratio: 1 };
        renderConfigForms();
        addChargerModal.style.display = 'none';
    });

    // Webhook UI
    const webhookChargeKeyInput = document.getElementById('webhook-charge-key');
    const webhookChargeToggle = document.getElementById('webhook-charge-toggle');
    const webhookChargeToggleText = document.getElementById('webhook-charge-toggle-text');
    
    const webhookAlarmKeyInput = document.getElementById('webhook-alarm-key');
    const webhookAlarmToggle = document.getElementById('webhook-alarm-toggle');
    const webhookAlarmToggleText = document.getElementById('webhook-alarm-toggle-text');

    const webhookOverloadKeyInput = document.getElementById('webhook-overload-key');
    const webhookOverloadToggle = document.getElementById('webhook-overload-toggle');
    const webhookOverloadToggleText = document.getElementById('webhook-overload-toggle-text');
    
    const webhookSaveBtn = document.getElementById('webhook-save-btn');
    const webhookMessage = document.getElementById('webhook-message');

    function loadWebhookSettings() {
        fetch(`${apiUrl}/webhook-settings`)
            .then(r => r.json())
            .then(data => {
                if (!data.charge) data.charge = {};
                if (!data.alarm) data.alarm = {};
                if (!data.overload) data.overload = {};
                
                webhookChargeKeyInput.value = data.charge.key || '';
                webhookChargeToggle.checked = data.charge.enabled !== false;
                webhookChargeToggleText.textContent = webhookChargeToggle.checked ? '已开启' : '已关闭';
                webhookChargeKeyInput.readOnly = true;
                
                webhookAlarmKeyInput.value = data.alarm.key || '';
                webhookAlarmToggle.checked = data.alarm.enabled !== false;
                webhookAlarmToggleText.textContent = webhookAlarmToggle.checked ? '已开启' : '已关闭';
                webhookAlarmKeyInput.readOnly = true;

                if (webhookOverloadKeyInput) {
                    webhookOverloadKeyInput.value = data.overload.key || '';
                    if (webhookOverloadToggle) {
                        webhookOverloadToggle.checked = data.overload.enabled !== false;
                        if (webhookOverloadToggleText) webhookOverloadToggleText.textContent = webhookOverloadToggle.checked ? '已开启' : '已关闭';
                    }
                    webhookOverloadKeyInput.readOnly = true;
                }

                // Sync with independent card on overload view
                const inpOverloadCard = document.getElementById('inp-overload-webhook-key');
                const toggleOverloadCard = document.getElementById('overload-webhook-toggle');
                const toggleTextOverloadCard = document.getElementById('overload-webhook-toggle-text');
                if (inpOverloadCard) inpOverloadCard.value = data.overload.key || '';
                if (toggleOverloadCard) {
                    toggleOverloadCard.checked = data.overload.enabled !== false;
                    if (toggleTextOverloadCard) toggleTextOverloadCard.textContent = toggleOverloadCard.checked ? '已开启' : '已关闭';
                }
            });
    }

    [webhookChargeKeyInput, webhookAlarmKeyInput, webhookOverloadKeyInput].forEach(inp => {
        if (!inp) return;
        inp.addEventListener('click', () => {
            if (inp.readOnly) {
                if (confirm("是否修改当前Token / Webhook 链接？")) {
                    inp.readOnly = false;
                    inp.style.cursor = 'text';
                    inp.focus();
                }
            }
        });
    });

    webhookChargeToggle.addEventListener('change', () => { webhookChargeToggleText.textContent = webhookChargeToggle.checked ? '已开启' : '已关闭'; });
    webhookAlarmToggle.addEventListener('change', () => { webhookAlarmToggleText.textContent = webhookAlarmToggle.checked ? '已开启' : '已关闭'; });
    if (webhookOverloadToggle && webhookOverloadToggleText) {
        webhookOverloadToggle.addEventListener('change', () => { webhookOverloadToggleText.textContent = webhookOverloadToggle.checked ? '已开启' : '已关闭'; });
    }

    function showWebhookMessage(msg, type) {
        webhookMessage.textContent = msg;
        webhookMessage.className = type === 'error' ? 'error-banner' : 'success-banner';
        setTimeout(() => { webhookMessage.className = 'error-banner hidden'; }, 3000);
    }

    webhookSaveBtn.addEventListener('click', () => {
        const payload = {
            charge: {
                key: webhookChargeKeyInput.value,
                enabled: webhookChargeToggle.checked
            },
            alarm: {
                key: webhookAlarmKeyInput.value,
                enabled: webhookAlarmToggle.checked
            },
            overload: {
                key: webhookOverloadKeyInput ? webhookOverloadKeyInput.value : '',
                enabled: webhookOverloadToggle ? webhookOverloadToggle.checked : true
            }
        };
        withAuth((pwd) => {
            fetch(`${apiUrl}/webhook-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-password': pwd },
                body: JSON.stringify(payload)
            }).then(async r => {
                if (r.status === 401) {
                    showWebhookMessage("保存失败：管理员密码错误", 'error');
                    return;
                }
                const data = await r.json();
                if(data.status === 'ok') {
                    showWebhookMessage("保存成功！", 'success');
                    webhookChargeKeyInput.readOnly = true;
                    webhookAlarmKeyInput.readOnly = true;
                    if (webhookOverloadKeyInput) webhookOverloadKeyInput.readOnly = true;
                    // Sync card in overload view
                    loadWebhookSettings();
                }
            });
        });
    });
    
    // --- Serial Servers Table Logic ---
    function renderSerialServersTable() {
        const tbody = document.getElementById('serial-servers-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        for (const [cid, config] of Object.entries(chargersConfig)) {
            const tr = document.createElement('tr');
            const state = lastData[cid] || {};
            const isOnline = state.status === 'success';
            const statusHtml = isOnline 
                ? '<span style="color: var(--success); font-weight: bold;">🟢 在线</span>' 
                : '<span style="color: var(--error); font-weight: bold;">🔴 离线</span>';
                
            let defaultCategory = config.server_category || '串口服务器';
            const category = defaultCategory;
            const serialParams = config.serial_params || '2400, 8, 1, Even (偶)';

            tr.innerHTML = `
                <td data-label="服务器 IP" style="font-family: monospace; font-size: 1.1rem; color: var(--text-main);">${config.host || '-'}</td>
                <td data-label="端口" style="color: var(--primary); font-weight: bold;">${config.port || '-'}</td>
                <td data-label="设备类别">${category}</td>
                <td data-label="串口参数">${serialParams}</td>
                <td data-label="关联设备">${config.name || cid}</td>
                <td data-label="网络状态">${statusHtml}</td>
            `;
            tbody.appendChild(tr);
        }
    }

    // Admin Settings UI
    const adminOldPwd = document.getElementById('admin-old-pwd');
    const adminNewPwd = document.getElementById('admin-new-pwd');
    const adminSaveBtn = document.getElementById('admin-save-btn');
    const adminMessage = document.getElementById('admin-message');

    function showAdminMessage(msg, type) {
        adminMessage.textContent = msg;
        adminMessage.className = type === 'error' ? 'error-banner' : 'success-banner';
        setTimeout(() => { adminMessage.className = 'error-banner hidden'; }, 3000);
    }

    adminSaveBtn.addEventListener('click', () => {
        const oldPwd = adminOldPwd.value;
        const newPwd = adminNewPwd.value;
        if (!oldPwd || !newPwd) {
            showAdminMessage("请输入原密码和新密码", "error");
            return;
        }
        
        fetch(`${apiUrl}/admin/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
        }).then(async r => {
            if (r.status !== 200) {
                const res = await r.json();
                showAdminMessage("修改失败: " + res.detail, "error");
                return;
            }
            const res = await r.json();
            if (res.status === 'ok') {
                showAdminMessage("密码修改成功！", "success");
                adminOldPwd.value = '';
                adminNewPwd.value = '';
            }
        });
    });

    // WebSocket Logic
    function connect() {
        if (ws) ws.close();
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            connectionLed.className = 'led connected';
            connectionText.textContent = '服务器已连接';
        };

        ws.onclose = () => {
            connectionLed.className = 'led';
            connectionText.textContent = '连接断开，正在重连...';
            setTimeout(connect, 2000);
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'realtime') {
                handleRealtimeData(data);
            } else if (data.type === 'current_overload_update') {
                handleOverloadRealtime(data.data);
            } else if (data.type === 'new_record') {
                appendRecord(data.charger_id, data.record);
            } else if (data.type === 'alarm') {
                appendAlarm(data.alarm);
            } else if (data.type === 'service_log') {
                appendServiceLog(data.log);
            }
        };
        
        ws.onerror = (err) => {
            console.error("WebSocket Error:", err);
            ws.close();
        };
    }

    function handleRealtimeData(data) {
        const cid = data.charger_id;
        if (!cid) return;
        
        lastData[cid] = data;
        
        updateMeterTableRow(data);
        renderSerialServersTable();
        if (data.energy_stats) {
            updateEnergyDashboard(cid, data.energy_stats);
        }
        updateGlobalDashboard();
        
        const view = document.getElementById(`view-${cid}`);
        if (!view) return;

        const dataGrid = view.querySelector('.data-grid');
        const emptyState = view.querySelector('.empty-state');
        const displayStart = view.querySelector('.display-start');
        const chargingLed = view.querySelector('.charging-led');
        const chargingText = view.querySelector('.charging-text');

        if (data.status === 'error') {
            displayStart.textContent = "连接失败: " + data.message;
            dataGrid.style.display = 'none';
            emptyState.style.display = 'flex';
        } else if (data.status === 'success') {
            displayStart.textContent = data.address;
            renderMetrics(dataGrid, emptyState, data.metrics, data.raw_metrics || {});
            
            if (data.charge_state === 'CHARGING') {
                if (data.idle_counter > 0) {
                    chargingLed.className = 'led';
                    chargingLed.style.backgroundColor = 'var(--warning)';
                    chargingText.textContent = `🟡 结束确认中 (${data.idle_counter}/3)`;
                    chargingText.style.color = 'var(--warning)';
                } else {
                    chargingLed.className = 'led connected';
                    chargingLed.style.backgroundColor = ''; 
                    chargingText.textContent = '🟢 正在充电';
                    chargingText.style.color = 'var(--success)';
                }
            } else if (data.charge_state === 'STANDBY') {
                if (data.start_counter > 0) {
                    chargingLed.className = 'led';
                    chargingLed.style.backgroundColor = 'var(--warning)';
                    chargingText.textContent = `🟡 充电确认中 (${data.start_counter}/3)`;
                    chargingText.style.color = 'var(--warning)';
                } else {
                    chargingLed.className = 'led';
                    chargingLed.style.backgroundColor = 'var(--warning)';
                    chargingText.textContent = `🟡 已充值，等待插枪`;
                    chargingText.style.color = 'var(--warning)';
                }
            } else {
                if (data.start_counter > 0) {
                    chargingLed.className = 'led';
                    chargingLed.style.backgroundColor = 'var(--warning)';
                    chargingText.textContent = `🟡 状态确认中 (${data.start_counter}/3)`;
                    chargingText.style.color = 'var(--warning)';
                } else {
                    chargingLed.className = 'led';
                    chargingLed.style.backgroundColor = 'var(--text-muted)';
                    chargingText.textContent = '⚪ 待机中';
                    chargingText.style.color = 'var(--text-main)';
                }
            }
            
            if (data.balance !== undefined && data.balance !== null) {
                chargingText.innerHTML += ` <span style="font-size:0.9em; color:var(--primary); margin-left:8px; font-weight:normal;">[余额: ${data.balance}元]</span>`;
            }
        }
    }

    // --- Energy Stats Dashboard 3-Column Logic ---
    function initEnergyDashboard() {
        const wrapper = document.getElementById('energy-columns-wrapper');
        if (!wrapper) return;
        wrapper.innerHTML = ''; // clear
        
        // Ensure 3 columns exist (A, B, Mid)
        ['charger-a', 'charger-mid', 'charger-b'].forEach(cid => {
            const col = document.createElement('div');
            col.id = `energy-col-${cid}`;
            col.style = "flex: 1; min-width: 300px; display: flex; flex-direction: column; gap: 1rem;";
            
            // 1. Header Box
            const headerBox = document.createElement('div');
            headerBox.className = "panel glass";
            headerBox.style = "text-align: center; padding: 1rem; border-radius: 8px;";
            const cName = chargersConfig[cid] ? chargersConfig[cid].name : cid;
            headerBox.innerHTML = `<h3 style="margin: 0; font-size: 1.2rem;">${cName}</h3>`;
            
            // 2. Monthly Box (Scrollable)
            const monthlyBox = document.createElement('div');
            monthlyBox.className = "panel glass";
            monthlyBox.style = "height: 200px; display: flex; flex-direction: column; padding: 1rem; border-radius: 8px;";
            monthlyBox.innerHTML = `
                <div style="text-align: center; margin-bottom: 0.5rem; font-weight: bold; color: var(--primary);">月度统计</div>
                <div style="flex: 1; overflow-y: auto; padding-right: 5px;">
                    <table class="records-table" style="width: 100%; text-align: center; font-size: 0.95rem;">
                        <tbody id="energy-history-month-body-${cid}">
                            <tr><td colspan="2" style="color: var(--text-muted);">暂无数据</td></tr>
                        </tbody>
                    </table>
                </div>
            `;
            
            // 3. Daily Box (Scrollable)
            const dailyBox = document.createElement('div');
            dailyBox.className = "panel glass";
            dailyBox.style = "flex: 1; min-height: 350px; display: flex; flex-direction: column; padding: 1rem; border-radius: 8px;";
            dailyBox.innerHTML = `
                <div style="text-align: center; margin-bottom: 0.5rem; font-weight: bold; color: var(--warning);">日度统计</div>
                <div style="flex: 1; overflow-y: auto; padding-right: 5px;">
                    <table class="records-table" style="width: 100%; text-align: center; font-size: 0.95rem;">
                        <tbody id="energy-history-day-body-${cid}">
                            <tr><td colspan="2" style="color: var(--text-muted);">暂无数据</td></tr>
                        </tbody>
                    </table>
                </div>
            `;
            
            col.appendChild(headerBox);
            col.appendChild(monthlyBox);
            col.appendChild(dailyBox);
            wrapper.appendChild(col);
        });
    }

    function updateEnergyDashboard(cid, stats) {
        const today = new Date().toISOString().split('T')[0];
        const month = today.slice(0, 7);
        const monthlyKwh = (stats.monthly && stats.monthly[month]) || 0;
        const dailyKwh = (stats.daily && stats.daily[today]) || 0;
        
        // Update Monthly Scrollable History
        const mTbody = document.getElementById(`energy-history-month-body-${cid}`);
        if (mTbody && stats.monthly) {
            mTbody.innerHTML = '';
            
            // Pin This Month at the top
            const trThisMonth = document.createElement('tr');
            trThisMonth.innerHTML = `
                <td style="color: var(--text-main); font-weight: bold; padding: 0.6rem 0;">${month} <span style="font-size: 0.8rem; color: var(--primary);">(本月)</span></td>
                <td style="color: var(--primary); font-weight: bold; font-size: 1.1rem;">${monthlyKwh.toFixed(2)}</td>
            `;
            mTbody.appendChild(trThisMonth);
            
            // List historical months
            const mDates = Object.keys(stats.monthly).filter(m => m !== month).sort((a, b) => b.localeCompare(a));
            mDates.forEach(m => {
                const kwh = stats.monthly[m];
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: var(--text-muted); padding: 0.5rem 0;">${m}</td>
                    <td style="color: var(--text-main); font-weight: bold;">${kwh.toFixed(2)}</td>
                `;
                mTbody.appendChild(tr);
            });
        }
        
        // Update Daily Scrollable History
        const dTbody = document.getElementById(`energy-history-day-body-${cid}`);
        if (dTbody && stats.daily) {
            dTbody.innerHTML = '';
            
            // Pin Today at the top
            const trToday = document.createElement('tr');
            trToday.innerHTML = `
                <td style="color: var(--text-main); font-weight: bold; padding: 0.6rem 0;">${today} <span style="font-size: 0.8rem; color: var(--warning);">(今日)</span></td>
                <td style="color: var(--warning); font-weight: bold; font-size: 1.1rem;">${dailyKwh.toFixed(2)}</td>
            `;
            dTbody.appendChild(trToday);
            
            // List historical days
            const dDates = Object.keys(stats.daily).filter(d => d !== today).sort((a, b) => b.localeCompare(a));
            dDates.forEach(d => {
                const kwh = stats.daily[d];
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: var(--text-muted); padding: 0.5rem 0;">${d}</td>
                    <td style="color: var(--text-main); font-weight: bold;">${kwh.toFixed(2)}</td>
                `;
                dTbody.appendChild(tr);
            });
        }
    }

    // --- Meter Management Table Logic ---
    function renderMeterTable() {
        const tbody = document.getElementById('meter-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        for (const [cid, config] of Object.entries(chargersConfig)) {
            const tr = document.createElement('tr');
            tr.id = `meter-row-${cid}`;
            
            tr.innerHTML = `
                <td data-label="名称">${config.name || '-'}</td>
                <td data-label="安装位置">${config.location || '-'}</td>
                <td data-label="SN码">${config.sn || '-'}</td>
                <td data-label="通讯地址">${config.address || '-'}</td>
                <td data-label="协议">${config.protocol || 'DL/T645-2007'}</td>
                <td data-label="状态" class="meter-status">⚪ 未连接</td>
                <td data-label="最后更新时间" class="meter-time">-</td>
                <td data-label="备注">${config.remarks || '-'}</td>
            `;
            tbody.appendChild(tr);
        }
    }

    function updateMeterTableRow(data) {
        const tr = document.getElementById(`meter-row-${data.charger_id}`);
        if (!tr) return;
        
        const statusTd = tr.querySelector('.meter-status');
        const timeTd = tr.querySelector('.meter-time');
        
        if (data.status === 'success') {
            statusTd.innerHTML = "🟢 已连接";
            statusTd.style.color = "var(--success)";
        } else {
            statusTd.innerHTML = "🔴 未连接";
            statusTd.style.color = "var(--error)";
        }
        
        if (data.update_time) {
            timeTd.textContent = data.update_time;
        }
    }

    function renderMetrics(dataGrid, emptyState, metrics, rawMetrics) {
        if (!metrics || Object.keys(metrics).length === 0) {
            dataGrid.style.display = 'none';
            emptyState.style.display = 'flex';
            return;
        }
        dataGrid.style.display = 'grid';
        emptyState.style.display = 'none';
        
        let html = '';
        for (const [key, value] of Object.entries(metrics)) {
            let label = key;
            let unit = "";
            const match = key.match(/(.*)\s*\((.*)\)/);
            if (match) {
                label = match[1];
                unit = match[2];
            }
            
            const rawValue = rawMetrics[key];
            let rawHtml = '';
            if (rawValue !== undefined && rawValue !== value) {
                rawHtml = `<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">表显原值: ${rawValue} ${unit}</div>`;
            }
            
            if (key === '电表时间') {
                rawHtml += `<div style="font-size: 0.85rem; color: #4CAF50; margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 5px;">💻 系统时间: <span class="sys-time-span"></span></div>`;
            }
            
            html += `
                <div class="data-card">
                    <div class="data-label">${label}</div>
                    <div class="data-value" style="${key === '电表时间' ? 'font-size: 1.2rem;' : ''}">${value} <span style="font-size: 1rem; color: var(--text-muted)">${unit}</span></div>
                    ${rawHtml}
                </div>
            `;
        }
        dataGrid.innerHTML = html;
    }

    function loadRecords() {
        ['charger-mid', 'charger-a', 'charger-b'].forEach(cid => {
            fetch(`${apiUrl}/records/${cid}`)
                .then(res => res.json())
                .then(records => {
                    const view = document.getElementById(`view-${cid}`);
                    if (!view) return;
                    const tbody = view.querySelector('.records-body');
                    if (tbody) {
                        tbody.innerHTML = '';
                        records.forEach(r => appendRecord(cid, r, false));
                    }
                })
                .catch(err => console.error("Could not load records:", err));
        });
    }

    function appendRecord(cid, record, prepend = true) {
        const view = document.getElementById(`view-${cid}`);
        if (!view) return;
        const tbody = view.querySelector('.records-body');
        if (!tbody) return;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${record.id}</td>
            <td>${record.start_time}</td>
            <td>${record.end_time || '-'}</td>
            <td style="color: var(--success); font-weight: bold;">
                ${record.consumed_kwh}
                <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;">
                    尖:${record.tou["尖"] || 0} 峰:${record.tou["峰"] || 0} 平:${record.tou["平"] || 0} 谷:${record.tou["谷"] || 0}
                </div>
            </td>
        `;
        if (prepend) {
            tbody.insertBefore(tr, tbody.firstChild);
        } else {
            tbody.appendChild(tr);
        }
    }

    function loadAlarms() {
        fetch(`${apiUrl}/alarms`)
            .then(res => res.json())
            .then(data => {
                const tbody = document.getElementById('alarms-table-body');
                if (tbody) {
                    tbody.innerHTML = '';
                    data.forEach(a => appendAlarm(a, false));
                }
            })
            .catch(err => console.error("Could not load alarms:", err));
            
        fetch(`${apiUrl}/alarms/config`)
            .then(res => res.json())
            .then(data => {
                document.getElementById('inp-over-voltage').value = data.over_voltage;
                document.getElementById('inp-under-voltage').value = data.under_voltage;
                document.getElementById('inp-over-current').value = data.over_current;
                document.getElementById('inp-over-power').value = data.over_power;
            })
            .catch(err => console.error("Could not load alarms config:", err));
    }

    function appendAlarm(alarm, prepend = true) {
        const tbody = document.getElementById('alarms-table-body');
        if (!tbody) return;
        
        const tr = document.createElement('tr');
        let levelColor = "var(--text-main)";
        if (alarm.level === 'error') levelColor = "var(--error)";
        else if (alarm.level === 'warning') levelColor = "var(--warning)";
        else if (alarm.level === 'info') levelColor = "var(--success)";
        
        const cName = chargersConfig[alarm.charger_id] ? chargersConfig[alarm.charger_id].name : alarm.charger_id;
        
        tr.innerHTML = `
            <td data-label="时间">${alarm.time}</td>
            <td data-label="设备名称">${cName}</td>
            <td data-label="告警类型" style="color: ${levelColor}; font-weight: bold;">${alarm.type}</td>
            <td data-label="级别">${alarm.level.toUpperCase()}</td>
            <td data-label="触发数值">${alarm.value || '-'}</td>
            <td data-label="详情描述">${alarm.message}</td>
        `;
        
        if (prepend) {
            tbody.insertBefore(tr, tbody.firstChild);
            // Show global toast if it's an error
            if (alarm.level === 'error') {
                const toast = document.createElement('div');
                toast.style.position = 'fixed';
                toast.style.top = '20px';
                toast.style.right = '20px';
                toast.style.background = 'rgba(255, 50, 50, 0.9)';
                toast.style.color = '#fff';
                toast.style.padding = '1rem';
                toast.style.borderRadius = '8px';
                toast.style.zIndex = '9999';
                toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
                toast.innerHTML = `<strong>🚨 ${alarm.charger_id} ${alarm.type}</strong><br>${alarm.message}`;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 5000);
            }
        } else {
            tbody.appendChild(tr);
        }
    }
    
    function loadServiceLogs() {
        fetch(`${apiUrl}/service_logs`)
            .then(res => res.json())
            .then(data => {
                const tbody = document.getElementById('service-logs-body');
                if (tbody) {
                    tbody.innerHTML = '';
                    if (data.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">暂无记录</td></tr>';
                    } else {
                        data.forEach(l => appendServiceLog(l, false));
                    }
                }
            })
            .catch(err => console.error("Could not load service logs:", err));
    }

    function appendServiceLog(log, prepend = true) {
        const tbody = document.getElementById('service-logs-body');
        if (!tbody) return;
        
        // Remove empty state if present
        if (tbody.children.length === 1 && tbody.children[0].innerText.includes("暂无记录")) {
            tbody.innerHTML = '';
        }
        
        const tr = document.createElement('tr');
        let statusColor = log.status === '成功' ? "var(--success)" : "var(--error)";
        const cName = chargersConfig[log.charger_id] ? chargersConfig[log.charger_id].name : log.charger_id;
        
        tr.innerHTML = `
            <td data-label="时间">${log.time}</td>
            <td data-label="设备名称">${cName}</td>
            <td data-label="状态" style="color: ${statusColor}; font-weight: bold;">${log.status}</td>
            <td data-label="详情描述">${log.message}</td>
        `;
        
        if (prepend) {
            tbody.insertBefore(tr, tbody.firstChild);
        } else {
            tbody.appendChild(tr);
        }
    }
    
    document.getElementById('save-alarms-config-btn').addEventListener('click', () => {
        const payload = {
            over_voltage: parseFloat(document.getElementById('inp-over-voltage').value),
            under_voltage: parseFloat(document.getElementById('inp-under-voltage').value),
            over_current: parseFloat(document.getElementById('inp-over-current').value),
            over_power: parseFloat(document.getElementById('inp-over-power').value)
        };
        
        withAuth((pwd) => {
            fetch(`${apiUrl}/alarms/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-password': pwd },
                body: JSON.stringify(payload)
            }).then(async r => {
                if (r.status !== 200) {
                    const res = await r.json();
                    showAdminMessage("保存失败: " + res.detail, "error");
                    return;
                }
                alert("告警设置已保存！");
            });
        });
    });

    function loadEnergyStats() {
        fetch(`${apiUrl}/energy_stats`)
            .then(res => res.json())
            .then(data => {
                for (const [cid, stats] of Object.entries(data)) {
                    updateEnergyDashboard(cid, stats);
                }
                updateGlobalDashboard();
            })
            .catch(err => console.error("Could not load energy stats:", err));
    }
    
    // --- Global Dashboard Engine ---
    function updateGlobalDashboard() {
        const totalPowerEl = document.getElementById('global-total-power');
        const todayEnergyEl = document.getElementById('global-today-energy');
        const networkStatusEl = document.getElementById('global-network-status');
        const chargingStatusEl = document.getElementById('global-charging-status');
        if (!totalPowerEl) return;

        let totalPower = 0.0;
        let todayEnergy = 0.0;
        let onlineCount = 0;
        let offlineCount = 0;
        let chargingCount = 0;
        let idleCount = 0;

        let standbyCount = 0;

        for (const cid of Object.keys(chargersConfig)) {
            const data = lastData[cid] || {};
            if (data.status === 'success') {
                onlineCount++;
                if (data.metrics && data.metrics['总有功功率 (kW)']) {
                    totalPower += data.metrics['总有功功率 (kW)'];
                }
                if (data.charge_state === 'CHARGING') {
                    chargingCount++;
                } else if (data.charge_state === 'STANDBY') {
                    standbyCount++;
                } else {
                    idleCount++;
                }
            } else {
                offlineCount++;
            }
            
            // Try to get today's energy from websocket data first, fallback to DOM if needed
            let cidTodayEnergy = 0;
            if (data.energy_stats && data.energy_stats.daily) {
                const today = new Date().toISOString().split('T')[0];
                cidTodayEnergy = data.energy_stats.daily[today] || 0;
            } else {
                // Fallback to reading from the individual dashboard if loaded initially
                const valEl = document.getElementById(`energy-today-${cid}`);
                if (valEl) {
                    cidTodayEnergy = parseFloat(valEl.textContent) || 0;
                }
            }
            todayEnergy += cidTodayEnergy;
        }

        totalPowerEl.innerHTML = `${totalPower.toFixed(2)} <span style="font-size: 1.2rem;">kW</span>`;
        todayEnergyEl.innerHTML = `${todayEnergy.toFixed(2)} <span style="font-size: 1.2rem;">kWh</span>`;
        
        networkStatusEl.innerHTML = `<span style="color: var(--success);">🟢 ${onlineCount} 在线</span> / <span style="color: var(--error);">🔴 ${offlineCount} 离线</span>`;
        chargingStatusEl.innerHTML = `<span style="color: var(--warning);">⚡ ${chargingCount} 充电</span> / <span style="color: var(--warning);">🟡 ${standbyCount} 充值</span> / <span style="color: var(--text-main);">⚪ ${idleCount} 空闲</span>`;
    }
    
    // --- Global Records Table (Charging Statistics) ---
    let globalRecords = [];
    let currentGlobalPage = 1;
    const recordsPerPage = 10;
    
    function loadGlobalRecords() {
        fetch(`${apiUrl}/all_records`)
            .then(res => res.json())
            .then(data => {
                globalRecords = data;
                currentGlobalPage = 1;
                renderGlobalRecordsTable();
            })
            .catch(err => console.error("Could not load global records:", err));
    }
    
    function renderGlobalRecordsTable() {
        const tbody = document.getElementById('global-records-body');
        const prevBtn = document.getElementById('global-records-prev');
        const nextBtn = document.getElementById('global-records-next');
        const pageInfo = document.getElementById('global-records-page-info');
        
        if (!tbody) return;
        
        const totalPages = Math.ceil(globalRecords.length / recordsPerPage) || 1;
        if (currentGlobalPage < 1) currentGlobalPage = 1;
        if (currentGlobalPage > totalPages) currentGlobalPage = totalPages;
        
        prevBtn.disabled = currentGlobalPage === 1;
        nextBtn.disabled = currentGlobalPage === totalPages;
        pageInfo.textContent = `第 ${currentGlobalPage} / ${totalPages} 页 (共 ${globalRecords.length} 条)`;
        
        tbody.innerHTML = '';
        
        if (globalRecords.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">暂无充电统计记录</td></tr>';
            return;
        }
        
        const startIdx = (currentGlobalPage - 1) * recordsPerPage;
        const pageRecords = globalRecords.slice(startIdx, startIdx + recordsPerPage);
        
        pageRecords.forEach(record => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${record.recharge_time || '-'}</td>
                <td><strong style="color: var(--primary);">${record.charger_name || record.charger_id}</strong></td>
                <td><span style="color: var(--success); font-weight: bold;">${record.recharge_amount !== undefined ? record.recharge_amount : '-'}</span></td>
                <td><span style="color: var(--warning); font-weight: bold;">${record.consumed_kwh}</span></td>
                <td>${record.end_time || '-'}</td>
            `;
            tbody.appendChild(tr);
        });
    }
    
    const prevBtn = document.getElementById('global-records-prev');
    const nextBtn = document.getElementById('global-records-next');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (currentGlobalPage > 1) {
                currentGlobalPage--;
                renderGlobalRecordsTable();
            }
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            const totalPages = Math.ceil(globalRecords.length / recordsPerPage) || 1;
            if (currentGlobalPage < totalPages) {
                currentGlobalPage++;
                renderGlobalRecordsTable();
            }
        });
    }

    // ==========================================
    // Current Overload Monitoring & Rule System
    // ==========================================
    let overloadRules = [];
    let overloadRealtime = [];

    const overloadCardsContainer = document.getElementById('overload-realtime-cards');
    const overloadRulesTableBody = document.getElementById('overload-rules-table-body');
    const addOverloadRuleBtn = document.getElementById('add-overload-rule-btn');
    const overloadRuleModal = document.getElementById('overload-rule-modal');
    const overloadModalTitle = document.getElementById('overload-modal-title');
    const overloadRuleIdInput = document.getElementById('overload-rule-id');
    const overloadRuleNameInput = document.getElementById('overload-rule-name');
    const overloadChargersCheckboxes = document.getElementById('overload-chargers-checkboxes');
    const overloadThresholdInput = document.getElementById('overload-rule-threshold');
    const overloadDurationInput = document.getElementById('overload-rule-duration');
    const overloadBurstCountInput = document.getElementById('overload-rule-burst-count');
    const overloadRepeatEnabledInput = document.getElementById('overload-rule-repeat-enabled');
    const repeatSettingsRow = document.getElementById('repeat-settings-row');
    const overloadRepeatIntervalInput = document.getElementById('overload-rule-repeat-interval');
    const overloadMaxRepeatInput = document.getElementById('overload-rule-max-repeat');
    const overloadCustomMsgInput = document.getElementById('overload-rule-custom-msg');
    const overloadCustomRecoveryMsgInput = document.getElementById('overload-rule-custom-recovery-msg');
    const overloadEnabledInput = document.getElementById('overload-rule-enabled');
    const overloadRecoveryInput = document.getElementById('overload-rule-recovery');
    const overloadModalError = document.getElementById('overload-modal-error');
    const overloadModalCancel = document.getElementById('overload-modal-cancel');
    const overloadModalSave = document.getElementById('overload-modal-save');

    function loadOverloadRules() {
        fetch(`${apiUrl}/current-overload/rules`)
            .then(res => res.json())
            .then(data => {
                overloadRules = data.rules || [];
                overloadRealtime = data.realtime || [];
                renderOverloadView();
            })
            .catch(err => console.error("Could not load overload rules:", err));
    }

    function handleOverloadRealtime(realtimeList) {
        if (!Array.isArray(realtimeList)) return;
        overloadRealtime = realtimeList;
        renderOverloadRealtimeCards();
    }

    function renderOverloadView() {
        renderOverloadRealtimeCards();
        renderOverloadRulesTable();
    }

    function renderOverloadRealtimeCards() {
        if (!overloadCardsContainer) return;
        if (overloadRules.length === 0) {
            overloadCardsContainer.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 2.5rem; text-align: center; color: var(--text-muted); background: rgba(0,0,0,0.2); border-radius: 12px; border: 1px dashed var(--glass-border);">
                    <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">暂无主线电流预警规则</p>
                    <p style="font-size: 0.85rem;">点击右上角「新增主线预警规则」以配置跨桩总电流监测与企业微信告警</p>
                </div>
            `;
            return;
        }

        overloadCardsContainer.innerHTML = '';
        overloadRules.forEach(rule => {
            const rt = overloadRealtime.find(r => r.rule_id === rule.id) || {
                rule_id: rule.id,
                name: rule.name,
                is_alarming: false,
                current_max: 0.0,
                phases: { A: 0.0, B: 0.0, C: 0.0 },
                chargers: {}
            };

            const curr = rt.current_max !== undefined ? rt.current_max : 0.0;
            const threshold = rule.threshold_current || 32.0;
            const percent = Math.min(Math.round((curr / threshold) * 100), 150);
            const isAlarming = !!rt.is_alarming;
            const isEnabled = rule.enabled !== false;

            let fillClass = 'normal';
            if (percent >= 100 || isAlarming) fillClass = 'danger';
            else if (percent >= 80) fillClass = 'warning';

            let statusBadge = '';
            if (!isEnabled) {
                statusBadge = '<span class="load-badge disabled">⚪ 已禁用</span>';
            } else if (isAlarming) {
                statusBadge = '<span class="load-badge overload">🚨 告警超载</span>';
            } else {
                statusBadge = '<span class="load-badge safe">🟢 正常运行</span>';
            }

            // Charger chips
            const chargerChipsHtml = (rule.chargers || []).map(cid => {
                const cname = chargersConfig[cid]?.name || cid;
                const cinfo = rt.chargers ? rt.chargers[cid] : null;
                const cmax = cinfo && cinfo.max !== undefined ? `${cinfo.max}A` : '-';
                return `
                    <div class="load-charger-chip" title="${cname} 峰值: ${cmax}">
                        <span class="chip-dot"></span>
                        <span>${cname}</span>
                        <strong style="color: white; margin-left: 2px;">${cmax}</strong>
                    </div>
                `;
            }).join('');

            const card = document.createElement('div');
            card.className = `load-card ${isAlarming ? 'alarming' : ''}`;
            card.innerHTML = `
                <div class="load-card-header">
                    <div class="load-card-title">
                        <span>⚡</span>
                        <span>${rule.name}</span>
                    </div>
                    ${statusBadge}
                </div>

                <div class="load-current-metrics">
                    <div class="load-current-main">
                        ${curr.toFixed(1)}<small>A (峰值)</small>
                    </div>
                    <div class="load-current-limit">
                        预警阈值 <span>${threshold}A</span> (${percent}%)
                    </div>
                </div>

                <div class="load-progress-bar">
                    <div class="load-progress-fill ${fillClass}" style="width: ${Math.min(percent, 100)}%;"></div>
                </div>

                <div class="load-phases-grid">
                    <div class="phase-pill">
                        <div class="phase-pill-label">A相负荷</div>
                        <div class="phase-pill-val">${(rt.phases?.A || 0.0).toFixed(1)}<small>A</small></div>
                    </div>
                    <div class="phase-pill">
                        <div class="phase-pill-label">B相负荷</div>
                        <div class="phase-pill-val">${(rt.phases?.B || 0.0).toFixed(1)}<small>A</small></div>
                    </div>
                    <div class="phase-pill">
                        <div class="phase-pill-label">C相负荷</div>
                        <div class="phase-pill-val">${(rt.phases?.C || 0.0).toFixed(1)}<small>A</small></div>
                    </div>
                </div>

                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: -0.3rem;">关联回路:</div>
                <div class="load-chargers-summary">
                    ${chargerChipsHtml || '<span style="color: var(--text-muted); font-size: 0.8rem;">未关联充电桩</span>'}
                </div>

                <div class="load-card-footer">
                    <span>持续: ${rule.duration_seconds || 4}s | 冷却: ${rule.cooldown_minutes || 10}m</span>
                    <div class="load-card-actions">
                        <button class="btn-icon-action btn-test-rule" data-id="${rule.id}" title="触发一次企业微信测试推送">⚡ 测试</button>
                        <button class="btn-icon-action btn-edit-rule" data-id="${rule.id}" title="编辑规则">✏️ 编辑</button>
                        <button class="btn-icon-action danger btn-del-rule" data-id="${rule.id}" title="删除规则">🗑️</button>
                    </div>
                </div>
            `;

            card.querySelector('.btn-test-rule').addEventListener('click', () => triggerTestAlert(rule.id));
            card.querySelector('.btn-edit-rule').addEventListener('click', () => openRuleModal(rule));
            card.querySelector('.btn-del-rule').addEventListener('click', () => deleteRule(rule.id));

            overloadCardsContainer.appendChild(card);
        });
    }

    function renderOverloadRulesTable() {
        if (!overloadRulesTableBody) return;
        if (overloadRules.length === 0) {
            overloadRulesTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">暂无预警规则</td>
                </tr>
            `;
            return;
        }

        overloadRulesTableBody.innerHTML = '';
        overloadRules.forEach(rule => {
            const tr = document.createElement('tr');
            
            const chargersText = (rule.chargers || []).map(cid => {
                return chargersConfig[cid]?.name || cid;
            }).join(' + ') || '-';

            const enabledBadge = rule.enabled !== false 
                ? '<span style="color: var(--success); font-weight: 600;">已启用</span>' 
                : '<span style="color: var(--text-muted);">已停用</span>';

            const recoveryBadge = rule.notify_on_recovery 
                ? '<span style="color: var(--primary);">已开启</span>' 
                : '<span style="color: var(--text-muted);">关闭</span>';

            const burstCount = rule.burst_count !== undefined ? rule.burst_count : 5;
            const repeatEnabled = rule.repeat_enabled === true;
            const repeatInterval = rule.repeat_interval_minutes || rule.cooldown_minutes || 10;
            const maxRepeat = parseInt(rule.max_repeat_count || 0, 10);
            let repeatText = '';
            if (!repeatEnabled) {
                repeatText = `<span style="color: var(--warning); font-size: 0.82rem; font-weight: 600;">连发 ${burstCount} 条 (单周期不重复)</span>`;
            } else if (maxRepeat > 0) {
                repeatText = `<span style="color: var(--primary); font-size: 0.85rem;">连发 ${burstCount} 条 / 每 ${repeatInterval} 分钟 (最多${maxRepeat}轮)</span>`;
            } else {
                repeatText = `<span style="color: var(--primary); font-size: 0.85rem;">连发 ${burstCount} 条 / 每 ${repeatInterval} 分钟 (持续提醒)</span>`;
            }

            const customMsg = (rule.custom_message || '').trim();
            const customMsgHtml = customMsg 
                ? `<span title="${customMsg.replace(/"/g, '&quot;')}" style="display: inline-block; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; color: #ffd166; font-size: 0.82rem;">${customMsg}</span>`
                : '<span style="color: var(--text-muted); font-size: 0.8rem;">默认卡片</span>';

            tr.innerHTML = `
                <td><strong>${rule.name}</strong></td>
                <td><span style="color: var(--primary);">${chargersText}</span></td>
                <td><span class="highlight-value">${rule.threshold_current}</span> A</td>
                <td>${rule.duration_seconds || 4} 秒</td>
                <td>${repeatText}</td>
                <td>${customMsgHtml}</td>
                <td>${recoveryBadge}</td>
                <td>${enabledBadge}</td>
                <td style="text-align: center;">
                    <div style="display: inline-flex; gap: 0.4rem;">
                        <button class="btn-icon-action btn-tbl-test" title="发送测试推送">⚡ 测试</button>
                        <button class="btn-icon-action btn-tbl-edit" title="编辑规则">✏️ 编辑</button>
                        <button class="btn-icon-action danger btn-tbl-del" title="删除规则">🗑️ 删除</button>
                    </div>
                </td>
            `;

            tr.querySelector('.btn-tbl-test').addEventListener('click', () => triggerTestAlert(rule.id));
            tr.querySelector('.btn-tbl-edit').addEventListener('click', () => openRuleModal(rule));
            tr.querySelector('.btn-tbl-del').addEventListener('click', () => deleteRule(rule.id));

            overloadRulesTableBody.appendChild(tr);
        });
    }

    function openRuleModal(ruleToEdit = null) {
        try {
            console.log("openRuleModal triggered, editing:", ruleToEdit);
            const modal = document.getElementById('overload-rule-modal') || overloadRuleModal;
            if (!modal) {
                console.error("Could not find overload-rule-modal DOM element!");
                alert("未找到预警弹窗组件，请按 Ctrl+F5 刷新！");
                return;
            }

            if (overloadModalError) overloadModalError.classList.add('hidden');
            if (overloadChargersCheckboxes) overloadChargersCheckboxes.innerHTML = '';

            const selectedChargers = new Set(ruleToEdit ? (ruleToEdit.chargers || []) : Object.keys(chargersConfig || {}));
            const chargerKeys = Object.keys(chargersConfig || {});

            if (overloadChargersCheckboxes) {
                if (chargerKeys.length === 0) {
                    overloadChargersCheckboxes.innerHTML = `<span style="color: var(--text-muted); font-size: 0.85rem;">暂无可用的充电桩配置</span>`;
                } else {
                    chargerKeys.forEach(cid => {
                        const conf = (chargersConfig && chargersConfig[cid]) || {};
                        const cname = conf.name || cid;
                        const isChecked = selectedChargers.has(cid);
                        const label = document.createElement('label');
                        label.className = `charger-checkbox-tag ${isChecked ? 'selected' : ''}`;
                        label.innerHTML = `
                            <input type="checkbox" value="${cid}" ${isChecked ? 'checked' : ''}>
                            <span>${cname}</span>
                        `;
                        const input = label.querySelector('input');
                        if (input) {
                            input.addEventListener('change', (e) => {
                                if (e.target.checked) label.classList.add('selected');
                                else label.classList.remove('selected');
                            });
                        }
                        overloadChargersCheckboxes.appendChild(label);
                    });
                }
            }

            const defaultName = '主回路过载预警 (' + (chargerKeys.map(k => (chargersConfig && chargersConfig[k] && chargersConfig[k].name) || k).join('+') || '总线') + ')';

            const overloadRuleWebhookInput = document.getElementById('overload-rule-webhook');

            if (ruleToEdit) {
                if (overloadModalTitle) overloadModalTitle.textContent = '✏️ 编辑主线电流预警规则';
                if (overloadRuleIdInput) overloadRuleIdInput.value = ruleToEdit.id || '';
                if (overloadRuleNameInput) overloadRuleNameInput.value = ruleToEdit.name || '';
                if (overloadThresholdInput) overloadThresholdInput.value = ruleToEdit.threshold_current !== undefined ? ruleToEdit.threshold_current : '32.0';
                if (overloadDurationInput) overloadDurationInput.value = ruleToEdit.duration_seconds !== undefined ? ruleToEdit.duration_seconds : 4;
                if (overloadBurstCountInput) overloadBurstCountInput.value = ruleToEdit.burst_count !== undefined ? ruleToEdit.burst_count : 5;
                if (overloadRepeatEnabledInput) overloadRepeatEnabledInput.checked = ruleToEdit.repeat_enabled === true;
                if (repeatSettingsRow && overloadRepeatEnabledInput) {
                    repeatSettingsRow.style.display = overloadRepeatEnabledInput.checked ? 'grid' : 'none';
                }
                if (overloadRepeatIntervalInput) overloadRepeatIntervalInput.value = ruleToEdit.repeat_interval_minutes || ruleToEdit.cooldown_minutes || 10;
                if (overloadMaxRepeatInput) overloadMaxRepeatInput.value = ruleToEdit.max_repeat_count !== undefined ? ruleToEdit.max_repeat_count : 0;
                if (overloadCustomMsgInput) overloadCustomMsgInput.value = ruleToEdit.custom_message || '';
                if (overloadCustomRecoveryMsgInput) overloadCustomRecoveryMsgInput.value = ruleToEdit.custom_recovery_message || '';
                if (overloadEnabledInput) overloadEnabledInput.checked = ruleToEdit.enabled !== false;
                if (overloadRecoveryInput) overloadRecoveryInput.checked = ruleToEdit.notify_on_recovery !== false;
                if (overloadRuleWebhookInput) overloadRuleWebhookInput.value = ruleToEdit.custom_webhook || '';
            } else {
                if (overloadModalTitle) overloadModalTitle.textContent = '➕ 新增主线电流预警规则';
                if (overloadRuleIdInput) overloadRuleIdInput.value = '';
                if (overloadRuleNameInput) overloadRuleNameInput.value = defaultName;
                if (overloadThresholdInput) overloadThresholdInput.value = '32.0';
                if (overloadDurationInput) overloadDurationInput.value = '4';
                if (overloadBurstCountInput) overloadBurstCountInput.value = '5';
                if (overloadRepeatEnabledInput) overloadRepeatEnabledInput.checked = false;
                if (repeatSettingsRow) repeatSettingsRow.style.display = 'none';
                if (overloadRepeatIntervalInput) overloadRepeatIntervalInput.value = '10';
                if (overloadMaxRepeatInput) overloadMaxRepeatInput.value = '0';
                if (overloadCustomMsgInput) overloadCustomMsgInput.value = '';
                if (overloadCustomRecoveryMsgInput) overloadCustomRecoveryMsgInput.value = '';
                if (overloadEnabledInput) overloadEnabledInput.checked = true;
                if (overloadRecoveryInput) overloadRecoveryInput.checked = true;
                if (overloadRuleWebhookInput) overloadRuleWebhookInput.value = '';
            }

            modal.style.display = 'flex';
            if (overloadRuleNameInput) setTimeout(() => overloadRuleNameInput.focus(), 50);
        } catch (e) {
            console.error("openRuleModal failed:", e);
            alert("打开预警规则弹窗出错: " + e.message);
        }
    }

    function closeRuleModal() {
        const modal = document.getElementById('overload-rule-modal') || overloadRuleModal;
        if (modal) modal.style.display = 'none';
    }

    // Expose to window for inline onclick safety
    window.openRuleModal = openRuleModal;
    window.closeRuleModal = closeRuleModal;

    if (overloadRuleModal) {
        overloadRuleModal.addEventListener('click', (e) => {
            if (e.target === overloadRuleModal) closeRuleModal();
        });
    }

    if (addOverloadRuleBtn) {
        addOverloadRuleBtn.addEventListener('click', () => openRuleModal(null));
    }
    if (overloadModalCancel) {
        overloadModalCancel.addEventListener('click', closeRuleModal);
    }

    // Insert placeholders for custom message template
    document.querySelectorAll('.btn-insert-tag').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const tag = btn.getAttribute('data-tag');
            const targetId = btn.getAttribute('data-target') || 'overload-rule-custom-msg';
            const textarea = document.getElementById(targetId) || overloadCustomMsgInput;
            if (!textarea || !tag) return;
            const start = textarea.selectionStart || textarea.value.length;
            const end = textarea.selectionEnd || textarea.value.length;
            const val = textarea.value;
            textarea.value = val.substring(0, start) + tag + val.substring(end);
            textarea.focus();
            setTimeout(() => {
                textarea.selectionStart = textarea.selectionEnd = start + tag.length;
            }, 0);
        });
    });

    // Handlers for independent overload push card
    const btnSaveOverloadWebhook = document.getElementById('btn-save-overload-webhook');
    const btnTestOverloadWebhook = document.getElementById('btn-test-overload-webhook');
    const inpOverloadWebhookKey = document.getElementById('inp-overload-webhook-key');
    const overloadWebhookToggle = document.getElementById('overload-webhook-toggle');
    const overloadWebhookToggleText = document.getElementById('overload-webhook-toggle-text');

    if (overloadWebhookToggle && overloadWebhookToggleText) {
        overloadWebhookToggle.addEventListener('change', () => {
            overloadWebhookToggleText.textContent = overloadWebhookToggle.checked ? '已开启' : '已关闭';
        });
    }

    if (btnSaveOverloadWebhook) {
        btnSaveOverloadWebhook.addEventListener('click', () => {
            const keyVal = inpOverloadWebhookKey ? inpOverloadWebhookKey.value.trim() : '';
            const enabledVal = overloadWebhookToggle ? overloadWebhookToggle.checked : true;
            withAuth((pwd) => {
                fetch(`${apiUrl}/current-overload/webhook`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-admin-password': pwd },
                    body: JSON.stringify({ key: keyVal, enabled: enabledVal })
                }).then(async r => {
                    if (r.status === 401) {
                        alert("密码错误，保存失败！");
                        return;
                    }
                    if (!r.ok) {
                        const err = await r.json();
                        alert("保存失败: " + (err.detail || '未知错误'));
                        return;
                    }
                    alert("主线预警独立推送通道保存成功！");
                    loadWebhookSettings();
                }).catch(e => alert("网络请求失败: " + e.message));
            });
        });
    }

    if (btnTestOverloadWebhook) {
        btnTestOverloadWebhook.addEventListener('click', () => {
            withAuth((pwd) => {
                fetch(`${apiUrl}/current-overload/test-webhook`, {
                    method: 'POST',
                    headers: { 'x-admin-password': pwd }
                }).then(async r => {
                    if (r.status === 401) {
                        alert("密码错误！");
                        return;
                    }
                    const data = await r.json();
                    if (r.ok) {
                        alert("独立通道测试推送成功！请查看企业微信群消息。");
                    } else {
                        alert("测试失败: " + (data.detail || '未知错误'));
                    }
                }).catch(e => alert("网络请求失败: " + e.message));
            });
        });
    }

    if (overloadRepeatEnabledInput && repeatSettingsRow) {
        overloadRepeatEnabledInput.addEventListener('change', () => {
            repeatSettingsRow.style.display = overloadRepeatEnabledInput.checked ? 'grid' : 'none';
        });
    }

    if (overloadModalSave) {
        overloadModalSave.addEventListener('click', () => {
            const ruleId = overloadRuleIdInput.value.trim();
            const ruleName = overloadRuleNameInput.value.trim();
            const threshold = parseFloat(overloadThresholdInput.value);
            const duration = parseInt(overloadDurationInput.value, 10);
            const burstCount = overloadBurstCountInput ? (parseInt(overloadBurstCountInput.value, 10) || 5) : 5;
            const repeatEnabled = overloadRepeatEnabledInput ? overloadRepeatEnabledInput.checked : false;
            const repeatInterval = overloadRepeatIntervalInput ? (parseInt(overloadRepeatIntervalInput.value, 10) || 10) : 10;
            const maxRepeat = overloadMaxRepeatInput ? (parseInt(overloadMaxRepeatInput.value, 10) || 0) : 0;
            const customMsg = overloadCustomMsgInput ? overloadCustomMsgInput.value.trim() : '';
            const customRecoveryMsg = overloadCustomRecoveryMsgInput ? overloadCustomRecoveryMsgInput.value.trim() : '';
            const enabled = overloadEnabledInput.checked;
            const recovery = overloadRecoveryInput.checked;
            const customWebhook = (document.getElementById('overload-rule-webhook')?.value || '').trim();

            if (!ruleName) {
                overloadModalError.textContent = '请输入规则名称';
                overloadModalError.classList.remove('hidden');
                return;
            }
            if (isNaN(threshold) || threshold <= 0) {
                overloadModalError.textContent = '请输入合法的预警阈值电流 (> 0)';
                overloadModalError.classList.remove('hidden');
                return;
            }

            const checkedCids = [];
            overloadChargersCheckboxes.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                checkedCids.push(cb.value);
            });

            if (checkedCids.length === 0) {
                overloadModalError.textContent = '请至少勾选一个关联充电桩';
                overloadModalError.classList.remove('hidden');
                return;
            }

            const ruleObj = {
                id: ruleId || `rule_${Date.now()}`,
                name: ruleName,
                chargers: checkedCids,
                threshold_current: threshold,
                duration_seconds: isNaN(duration) ? 4 : duration,
                burst_count: burstCount,
                repeat_enabled: repeatEnabled,
                repeat_interval_minutes: repeatInterval,
                cooldown_minutes: repeatInterval,
                max_repeat_count: maxRepeat,
                custom_message: customMsg,
                custom_recovery_message: customRecoveryMsg,
                notify_on_recovery: recovery,
                enabled: enabled,
                custom_webhook: customWebhook
            };

            let updatedList = [...overloadRules];
            const existingIdx = updatedList.findIndex(r => r.id === ruleObj.id);
            if (existingIdx >= 0) {
                updatedList[existingIdx] = ruleObj;
            } else {
                updatedList.push(ruleObj);
            }

            withAuth((pwd) => {
                fetch(`${apiUrl}/current-overload/rules`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-admin-password': pwd
                    },
                    body: JSON.stringify({ rules: updatedList })
                })
                .then(async res => {
                    if (res.status === 401) {
                        alert("密码错误，保存失败！");
                        return;
                    }
                    if (!res.ok) {
                        const err = await res.json();
                        alert(`保存失败: ${err.detail || '未知错误'}`);
                        return;
                    }
                    const data = await res.json();
                    overloadRules = data.rules || updatedList;
                    closeRuleModal();
                    renderOverloadView();
                })
                .catch(err => {
                    alert(`网络请求异常: ${err.message}`);
                });
            });
        });
    }

    function deleteRule(ruleId) {
        const rule = overloadRules.find(r => r.id === ruleId);
        if (!rule) return;
        if (!confirm(`确定要删除规则「${rule.name}」吗？`)) return;

        const updatedList = overloadRules.filter(r => r.id !== ruleId);
        withAuth((pwd) => {
            fetch(`${apiUrl}/current-overload/rules`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-password': pwd
                },
                body: JSON.stringify({ rules: updatedList })
            })
            .then(async res => {
                if (res.status === 401) {
                    alert("密码错误，删除失败！");
                    return;
                }
                if (!res.ok) {
                    const err = await res.json();
                    alert(`删除失败: ${err.detail || '未知错误'}`);
                    return;
                }
                const data = await res.json();
                overloadRules = data.rules || updatedList;
                renderOverloadView();
            })
            .catch(err => {
                alert(`网络异常: ${err.message}`);
            });
        });
    }

    function triggerTestAlert(ruleId) {
        const rule = overloadRules.find(r => r.id === ruleId);
        const name = rule ? rule.name : ruleId;
        if (!confirm(`确定向企业微信发送「${name}」的测试推送吗？`)) return;

        withAuth((pwd) => {
            fetch(`${apiUrl}/current-overload/test-alert/${ruleId}`, {
                method: 'POST',
                headers: { 'x-admin-password': pwd }
            })
            .then(async res => {
                if (res.status === 401) {
                    alert("密码错误！");
                    return;
                }
                const data = await res.json();
                if (res.ok) {
                    alert(`测试推送发送成功！\n请查看企业微信群消息。\n(详细响应: ${data.detail || 'OK'})`);
                } else {
                    alert(`测试推送失败: ${data.detail || '未知错误'}`);
                }
            })
            .catch(err => alert(`网络异常: ${err.message}`));
        });
    }

    loadSettings();
    loadWebhookSettings();
    loadRecords();
    loadAlarms();
    loadServiceLogs();
    initEnergyDashboard();
    loadEnergyStats();
    loadGlobalRecords();
    loadOverloadRules();

    // Global tick for dynamic system time display
    setInterval(() => {
        const sysTime = new Date();
        const sysStr = sysTime.getFullYear() + "-" + String(sysTime.getMonth()+1).padStart(2, '0') + "-" + String(sysTime.getDate()).padStart(2, '0') + " " + String(sysTime.getHours()).padStart(2, '0') + ":" + String(sysTime.getMinutes()).padStart(2, '0') + ":" + String(sysTime.getSeconds()).padStart(2, '0');
        document.querySelectorAll('.sys-time-span').forEach(el => {
            el.textContent = sysStr;
        });
    }, 1000);
});
