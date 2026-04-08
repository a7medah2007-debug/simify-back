const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// تهيئة Firebase
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
    });
}

const db = admin.firestore();
const HERO_KEY = process.env.HERO_API_KEY;
const HERO_URL = "https://hero-sms.com/stubs/handler_api.php";

// ========== دوال مساعدة ==========

// جلب رصيد المستخدم من Firebase
async function getUserBalance(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    return userDoc.exists ? (userDoc.data().balance || 0) : 0;
}

// خصم رصيد من المستخدم
async function deductBalance(uid, amount, description) {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const currentBalance = userDoc.data().balance || 0;
    
    if (currentBalance < amount) {
        throw new Error('Insufficient balance');
    }
    
    await userRef.update({ balance: admin.firestore.FieldValue.increment(-amount) });
    
    // تسجيل العملية
    await db.collection('transactions').add({
        uid, amount: -amount, type: 'debit', description,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return currentBalance - amount;
}

// إضافة رصيد للمستخدم
async function addBalance(uid, amount, description) {
    const userRef = db.collection('users').doc(uid);
    await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
    
    await db.collection('transactions').add({
        uid, amount, type: 'credit', description,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return await getUserBalance(uid);
}

// ========== API Endpoints ==========

// 1. فحص صحة السيرفر
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 2. جلب رصيد المستخدم
app.get('/api/balance', async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, error: 'UID required' });
        
        const balance = await getUserBalance(uid);
        res.json({ success: true, balance });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. جلب قائمة الدول المتاحة
app.get('/api/countries', async (req, res) => {
    try {
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getCountries`);
        res.json({ success: true, countries: response.data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. جلب قائمة الخدمات
app.get('/api/services', async (req, res) => {
    try {
        const { country } = req.query;
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getServicesList`;
        if (country) url += `&country=${country}`;
        
        const response = await axios.get(url);
        res.json({ success: true, services: response.data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. جلب الأسعار الحالية
app.get('/api/prices', async (req, res) => {
    try {
        const { service, country } = req.query;
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices`;
        if (service) url += `&service=${service}`;
        if (country) url += `&country=${country}`;
        
        const response = await axios.get(url);
        res.json({ success: true, prices: response.data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. طلب رقم جديد (باستخدام V2)
app.get('/api/get-number', async (req, res) => {
    try {
        const { uid, service, country, maxPrice } = req.query;
        
        // Validation
        if (!uid) return res.status(400).json({ success: false, error: 'UID required' });
        if (!service) return res.status(400).json({ success: false, error: 'Service required' });
        if (!country) return res.status(400).json({ success: false, error: 'Country required' });
        
        // استخدام getNumberV2 للحصول على بيانات كاملة
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getNumberV2&service=${service}&country=${country}`;
        if (maxPrice) url += `&maxPrice=${maxPrice}`;
        
        const response = await axios.get(url);
        const data = response.data;
        
        // لو رجع string يبقى Error
        if (typeof data === 'string') {
            if (data.includes('NO_BALANCE')) {
                return res.status(402).json({ success: false, error: 'رصيد HeroSMS غير كافي' });
            }
            if (data.includes('NO_NUMBERS')) {
                return res.status(404).json({ success: false, error: 'لا توجد أرقام متاحة حالياً' });
            }
            if (data.includes('BAD_SERVICE')) {
                return res.status(400).json({ success: false, error: 'الخدمة غير صحيحة' });
            }
            return res.status(400).json({ success: false, error: data });
        }
        
        // خصم الرصيد من المستخدم
        const cost = data.activationCost;
        try {
            const newBalance = await deductBalance(uid, cost, `شراء رقم: ${service} - ${data.phoneNumber}`);
            
            res.json({
                success: true,
                activationId: data.activationId,
                phoneNumber: data.phoneNumber,
                cost: cost,
                currency: data.currency,
                countryCode: data.countryCode,
                activationEndTime: data.activationEndTime,
                canGetAnotherSms: data.canGetAnotherSms,
                remainingBalance: newBalance
            });
        } catch (balanceError) {
            // لو الرصيد مش كافي، نلغي الرقم من HeroSMS
            await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${data.activationId}&status=8`);
            return res.status(402).json({ success: false, error: 'رصيدك غير كافي' });
        }
        
    } catch (err) {
        console.error('Get number error:', err);
        res.status(500).json({ success: false, error: 'حصلت مشكلة في السيرفر' });
    }
});

// 7. فحص وجود كود (باستخدام V2)
app.get('/api/get-sms', async (req, res) => {
    try {
        const { activationId } = req.query;
        
        if (!activationId) {
            return res.status(400).json({ success: false, error: 'Activation ID required' });
        }
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getStatusV2&id=${activationId}`);
        const data = response.data;
        
        // لو رجع string (القديم)
        if (typeof data === 'string') {
            if (data.includes('STATUS_OK')) {
                const code = data.split(':')[1];
                return res.json({ success: true, code, status: 'received' });
            }
            if (data === 'STATUS_WAIT_CODE') {
                return res.json({ success: false, status: 'waiting', message: 'في انتظار الكود' });
            }
            if (data.includes('STATUS_WAIT_RETRY')) {
                return res.json({ success: false, status: 'waiting', message: 'جاري إعادة الإرسال' });
            }
            if (data === 'STATUS_CANCEL') {
                return res.json({ success: false, status: 'cancelled', message: 'تم إلغاء الرقم' });
            }
            return res.json({ success: false, status: 'unknown', message: data });
        }
        
        // التعامل مع V2 response (JSON)
        if (data.sms && data.sms.code) {
            return res.json({
                success: true,
                status: 'received',
                code: data.sms.code,
                text: data.sms.text,
                type: 'sms'
            });
        }
        
        if (data.call && data.call.code) {
            return res.json({
                success: true,
                status: 'received',
                code: data.call.code,
                text: data.call.text,
                audioUrl: data.call.url,
                type: 'call'
            });
        }
        
        res.json({ success: false, status: 'waiting', message: 'في انتظار الكود' });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. إعادة إرسال SMS
app.post('/api/resend-sms', async (req, res) => {
    try {
        const { activationId } = req.body;
        
        if (!activationId) {
            return res.status(400).json({ success: false, error: 'Activation ID required' });
        }
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=3`);
        
        if (response.data.includes('ACCESS_RETRY_GET')) {
            res.json({ success: true, message: 'تم طلب إعادة الإرسال' });
        } else {
            res.json({ success: false, error: response.data });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. إلغاء الرقم واسترجاع الرصيد
app.post('/api/cancel-number', async (req, res) => {
    try {
        const { uid, activationId, refundAmount } = req.body;
        
        if (!uid) return res.status(400).json({ success: false, error: 'UID required' });
        if (!activationId) return res.status(400).json({ success: false, error: 'Activation ID required' });
        if (!refundAmount) return res.status(400).json({ success: false, error: 'Refund amount required' });
        
        // إلغاء الرقم في HeroSMS
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=8`);
        
        if (response.data.includes('ACCESS_CANCEL') || response.data.includes('STATUS_CANCEL')) {
            // استرجاع الرصيد للمستخدم
            const newBalance = await addBalance(uid, parseFloat(refundAmount), `استرجاع رصيد - إلغاء رقم ${activationId}`);
            
            res.json({
                success: true,
                message: 'تم إلغاء الرقم واسترجاع الرصيد',
                newBalance
            });
        } else {
            res.json({ success: false, error: response.data });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10. إنهاء التفعيل (بعد استلام الكود)
app.post('/api/complete-activation', async (req, res) => {
    try {
        const { activationId } = req.body;
        
        if (!activationId) {
            return res.status(400).json({ success: false, error: 'Activation ID required' });
        }
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=6`);
        
        if (response.data.includes('ACCESS_ACTIVATION')) {
            res.json({ success: true, message: 'تم إنهاء التفعيل بنجاح' });
        } else {
            res.json({ success: false, error: response.data });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 11. جلب التفعيلات النشطة
app.get('/api/active-activations', async (req, res) => {
    try {
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getActiveActivations`);
        res.json({ success: true, activations: response.data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = app;
