const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const webpush = require('web-push');

// --- 초기 설정 ---
const app = express();
const server = http.createServer(app);
const io = socketio(server, { path: "/socket.io" });
const db = new sqlite3.Database('./db/main.db', err => {
    if (err) console.error("DB 연결 실패:", err.message);
    else console.log("DB 연결 성공.");
});

// ★★★ [VAPID 키 설정] ★★★
// 위에서 생성한 키를 여기에 붙여넣으세요.
const vapidKeys = {
  publicKey: "BA8aLGnr2aXd8qSCVirpsD_2RtCvPSaGOSvCapRulSNBf3IjrnOyklBDxy3LsU5gzxTOXuUR50uCLWRWhpMZcvw",
  privateKey: "ZcnzKAUbGDlZZqHfQjBGzYi04o7vP0_cqkTw8OwI8GE"
};

webpush.setVapidDetails(
    'mailto:your-email@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

// --- 인메모리 저장소 ---
const userSockets = {};

// --- Express 미들웨어 설정 ---
app.use(express.static(__dirname));
app.use(express.json());

// --- 라우팅 ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/save-subscription', (req, res) => {
    const { num, subscription } = req.body;
    if (num !== undefined && subscription) {
        const subStr = JSON.stringify(subscription);
        db.run("UPDATE account SET subscription = ? WHERE num = ?", [subStr, num], (err) => {
            if (err) {
                console.error(`[푸시 DB 저장 실패] ${num}번 유저:`, err.message);
                return res.status(500).json({ message: 'Failed to save subscription.' });
            }
            console.log(`[푸시] ${num}번 유저의 구독 정보 DB에 저장/갱신 완료.`);
            res.status(201).json({ message: 'Subscription saved.' });
        });
    } else {
        res.status(400).json({ message: 'Invalid subscription data.' });
    }
});

// --- Socket.IO 로직 ---
io.on('connection', (socket) => {
    console.log(`[연결] 새로운 유저 접속. 소켓 ID: ${socket.id}`);

    socket.on("login", (e) => {
        const { id, pw } = JSON.parse(e);
        db.get("SELECT * FROM account WHERE id = ? AND pw = ?", [id, pw], (err, user) => {
            if (err) return;
            if (user) {
                socket.userNum = user.num;
                userSockets[user.num] = socket.id;
                console.log(`[로그인] ${user.name}(${user.num}) 로그인 완료. 현재 접속자:`, Object.keys(userSockets));
                socket.emit("login_s", JSON.stringify({ ...user, status: "ok" }));
            } else {
                socket.emit("login_s", JSON.stringify({ id, status: "failed" }));
            }
        });
    });

    socket.on("relogin", (data) => {
        if (data.num !== undefined) {
            socket.userNum = data.num;
            userSockets[data.num] = socket.id;
            console.log(`[재접속] ${data.name}(${data.num}) 재접속 완료. 현재 접속자:`, Object.keys(userSockets));
        }
    });

    socket.on("chat", (data) => {
        const { fromNum, toNum, fromName, toName, msg } = data;
        const toNumArr = Array.isArray(toNum) ? toNum : [toNum];

        if (fromNum !== 0 && !toNumArr.includes(0)) {
            console.log(`[차단] 학생간 메시지 시도: ${fromName} -> ${toName}`);
            return;
        }

        const toNumStr = JSON.stringify(toNumArr);
        const toNameStr = Array.isArray(toName) ? JSON.stringify(toName) : toName;

        const stmt = db.prepare(`INSERT INTO chat (fromNum, fromName, toNum, toName, msg, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))`);
        stmt.run(fromNum, fromName, toNumStr, toNameStr, msg, function(err) {
            if (err) return console.error(err);

            const recipients = [...new Set([...toNumArr, fromNum])];
            console.log(`[메시지] ${fromName} -> ${toName} (${msg}). 전송 대상: ${recipients}`);

            recipients.forEach(userNum => {
                const targetSocketId = userSockets[userNum];
                if (targetSocketId) {
                    io.to(targetSocketId).emit("chat", data);
                    console.log(`  -> ${userNum}번에게 실시간 전송 성공`);
                } else if (userNum !== fromNum) {
                    console.log(`  -> ${userNum}번은 미접속 상태.`);
                    db.get("SELECT subscription FROM account WHERE num = ?", [userNum], (err, row) => {
                        if (err) return console.error("구독 정보 조회 실패:", err.message);
                        if (row && row.subscription) {
                            try {
                                const subscription = JSON.parse(row.subscription);
                                const payload = JSON.stringify({ title: `새 메시지: ${fromName}`, body: msg });

                                webpush.sendNotification(subscription, payload)
                                    .then(() => console.log(`    -> ${userNum}번에게 푸시 알림 전송 성공`))
                                    .catch(err => {
                                        if (err.statusCode === 410) {
                                            db.run("UPDATE account SET subscription = NULL WHERE num = ?", [userNum]);
                                            console.log(`    -> ${userNum}번의 구독이 만료되어 DB에서 삭제합니다.`);
                                        } else {
                                            console.error(`    -> ${userNum}번에게 푸시 알림 전송 실패:`, err.body || err);
                                        }
                                    });
                            } catch (parseError) {
                                console.error(`    -> ${userNum}번의 구독 정보 파싱 실패:`, parseError);
                            }
                        } else {
                            console.log(`    -> ${userNum}번은 구독 정보가 DB에 없습니다.`);
                        }
                    });
                }
            });
        });
        stmt.finalize();
    });

    socket.on("load_chat", (num) => {
        db.all(`SELECT * FROM chat ORDER BY timestamp ASC`, [], (err, rows) => {
            if (err) return console.error(err);
            rows.forEach(r => {
                try { r.toNum = JSON.parse(r.toNum); } catch { r.toNum = [r.toNum]; }
                if (!Array.isArray(r.toNum)) r.toNum = [r.toNum];
            });
            const filtered = rows.filter(row => row.fromNum === num || row.toNum.includes(num));
            socket.emit("chat_history", filtered);
        });
    });

    socket.on("disconnect", () => {
        if (socket.userNum !== undefined) {
            if (userSockets[socket.userNum] === socket.id) {
                delete userSockets[socket.userNum];
                console.log(`[접속종료] ${socket.userNum}번 유저 퇴장. 현재 접속자:`, Object.keys(userSockets));
            }
        } else {
            console.log(`[연결끊김] 비로그인 유저 퇴장. 소켓 ID: ${socket.id}`);
        }
    });
});

// --- 서버 실행 ---
const PORT = 6464;
server.listen(PORT, "0.0.0.0", () => console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`));