const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== تهيئة Firebase ====================
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

// ==================== الإعدادات الافتراضية ====================
const DEFAULT_SETTINGS = {
    usdToEgp: 50,
    profitMargin: 20,
    minPrice: 10
};

// ==================== دوال مساعدة ====================

// جلب الإعدادات من Firestore
async function getSettings() {
    try {
        const doc = await db.collection('settings').doc('pricing').get();
        if (doc.exists) {
            return { ...DEFAULT_SETTINGS, ...doc.data() };
        }
        return DEFAULT_SETTINGS;
    } catch (error) {
        console.error('Error getting settings:', error);
        return DEFAULT_SETTINGS;
    }
}

// جلب رصيد المستخدم
async function getUserBalance(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    return userDoc.exists ? (userDoc.data().balance || 0) : 0;
}

// خصم رصيد من المستخدم
async function deductBalance(uid, amount, description) {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const currentBalance = userDoc.data()?.balance || 0;
    
    if (currentBalance < amount) {
        throw new Error('Insufficient balance');
    }
    
    await userRef.update({ balance: admin.firestore.FieldValue.increment(-amount) });
    
    // تسجيل العملية
    await db.collection('transactions').add({
        uid,
        type: 'debit',
        amount: -amount,
        description,
        status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return currentBalance - amount;
}

// إضافة رصيد للمستخدم
async function addBalance(uid, amount, description) {
    const userRef = db.collection('users').doc(uid);
    await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
    
    await db.collection('transactions').add({
        uid,
        type: 'credit',
        amount,
        description,
        status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return await getUserBalance(uid);
}

// تحويل السعر من دولار لمصري مع إضافة الربح
async function convertPrice(usdPrice) {
    const settings = await getSettings();
    const usdToEgp = settings.usdToEgp || 50;
    const profitMargin = settings.profitMargin || 20;
    const minPrice = settings.minPrice || 10;
    
    let egpPrice = usdPrice * usdToEgp;
    egpPrice = egpPrice * (1 + profitMargin / 100);
    egpPrice = Math.max(egpPrice, minPrice);
    
    return Math.round(egpPrice * 100) / 100;
}

// ==================== API Endpoints ====================

// 1. فحص صحة السيرفر
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        message: 'Simify API is running'
    });
});

// 2. جلب الإعدادات
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. تحديث الإعدادات
app.post('/api/settings', async (req, res) => {
    try {
        const { usdToEgp, profitMargin, minPrice } = req.body;
        const updates = {};
        
        if (usdToEgp !== undefined) updates.usdToEgp = usdToEgp;
        if (profitMargin !== undefined) updates.profitMargin = profitMargin;
        if (minPrice !== undefined) updates.minPrice = minPrice;
        
        await db.collection('settings').doc('pricing').set(updates, { merge: true });
        
        res.json({ success: true, message: 'تم تحديث الإعدادات' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. جلب رصيد المستخدم
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

// 5. جلب قائمة الدول
app.get('/api/countries', async (req, res) => {
    try {
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getCountries`);
        res.json({ success: true, countries: response.data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. جلب قائمة الخدمات
app.get('/api/services', async (req, res) => {
    try {
        const { country } = req.query;
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getServicesList`;
        if (country) url += `&country=${country}`;
        
        const response = await axios.get(url);
        
        // تجهيز الخدمات بشكل مناسب للفرونت
        let services = [];
        if (response.data && response.data.services) {
            services = response.data.services;
        } else if (Array.isArray(response.data)) {
            services = response.data;
        }
        
        res.json({ success: true, services });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. جلب الأسعار (مع التحويل للمصري وإضافة الربح)
app.get('/api/prices', async (req, res) => {
    try {
        const { service, country } = req.query;
        const settings = await getSettings();
        
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices`;
        if (service) url += `&service=${service}`;
        if (country) url += `&country=${country}`;
        
        const response = await axios.get(url);
        const pricesData = response.data;
        
        // تحويل الأسعار
        const converted = {};
        for (const [countryCode, services] of Object.entries(pricesData)) {
            converted[countryCode] = {};
            for (const [serviceCode, data] of Object.entries(services)) {
                if (data && typeof data.cost === 'number') {
                    const egpPrice = await convertPrice(data.cost);
                    converted[countryCode][serviceCode] = {
                        ...data,
                        costUsd: data.cost,
                        costEgp: egpPrice
                    };
                } else {
                    converted[countryCode][serviceCode] = data;
                }
            }
        }
        
        res.json({ 
            success: true, 
            prices: converted,
            meta: {
                usdToEgp: settings.usdToEgp,
                profitMargin: settings.profitMargin
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. جلب سعر خدمة في دولة محددة
app.get('/api/price', async (req, res) => {
    try {
        const { service, country } = req.query;
        
        if (!service || !country) {
            return res.status(400).json({ success: false, error: 'Service and country required' });
        }
        
        const url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices&service=${service}&country=${country}`;
        const response = await axios.get(url);
        const pricesData = response.data;
        
        let usdPrice = 0;
        if (pricesData[country] && pricesData[country][service]) {
            usdPrice = pricesData[country][service].cost || 0;
        }
        
        const egpPrice = await convertPrice(usdPrice);
        const settings = await getSettings();
        
        res.json({ 
            success: true, 
            price: {
                usd: usdPrice,
                egp: egpPrice,
                exchangeRate: settings.usdToEgp,
                profitMargin: settings.profitMargin
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. طلب رقم جديد (V2)
app.get('/api/get-number', async (req, res) => {
    try {
        const { uid, service, country, maxPrice } = req.query;
        
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
            if (data.includes('WRONG_COUNTRY')) {
                return res.status(400).json({ success: false, error: 'الدولة غير صحيحة' });
            }
            return res.status(400).json({ success: false, error: data });
        }
        
        // تحويل السعر للمصري
        const usdCost = data.activationCost || 0;
        const egpCost = await convertPrice(usdCost);
        
        // التحقق من رصيد المستخدم
        const currentBalance = await getUserBalance(uid);
        
        if (currentBalance < egpCost) {
            // إلغاء الرقم من HeroSMS
            try {
                await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${data.activationId}&status=8`);
            } catch (e) {}
            return res.status(402).json({ success: false, error: 'رصيدك غير كافي' });
        }
        
        // خصم الرصيد
        const newBalance = await deductBalance(uid, egpCost, `شراء رقم ${service} - ${data.phoneNumber}`);
        
        // حفظ التفعيل في Firestore
        await db.collection('activations').add({
            uid,
            activationId: data.activationId,
            service,
            country,
            phoneNumber: data.phoneNumber,
            cost: egpCost,
            costUsd: usdCost,
            status: 'active',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            activationEndTime: data.activationEndTime
        });
        
        const settings = await getSettings();
        
        res.json({
            success: true,
            activationId: data.activationId,
            phoneNumber: data.phoneNumber,
            cost: egpCost,
            costUsd: usdCost,
            exchangeRate: settings.usdToEgp,
            profit: settings.profitMargin,
            currency: 'EGP',
            countryCode: data.countryCode,
            activationEndTime: data.activationEndTime,
            canGetAnotherSms: data.canGetAnotherSms,
            remainingBalance: newBalance
        });
        
    } catch (err) {
        console.error('Get number error:', err);
        res.status(500).json({ success: false, error: 'حصلت مشكلة في السيرفر' });
    }
});

// 10. فحص وجود كود (V2)
app.get('/api/get-sms', async (req, res) => {
    try {
        const { activationId } = req.query;
        
        if (!activationId) {
            return res.status(400).json({ success: false, error: 'Activation ID required' });
        }
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getStatusV2&id=${activationId}`);
        const data = response.data;
        
        // لو رجع string (النظام القديم)
        if (typeof data === 'string') {
            if (data.includes('STATUS_OK')) {
                const code = data.split(':')[1];
                
                // تحديث حالة التفعيل
                const activationsRef = db.collection('activations');
                const snapshot = await activationsRef.where('activationId', '==', activationId).get();
                snapshot.forEach(async (doc) => {
                    await doc.ref.update({
                        status: 'completed',
                        code: code,
                        completedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
                
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
            // تحديث حالة التفعيل
            const activationsRef = db.collection('activations');
            const snapshot = await activationsRef.where('activationId', '==', activationId).get();
            snapshot.forEach(async (doc) => {
                await doc.ref.update({
                    status: 'completed',
                    code: data.sms.code,
                    fullMessage: data.sms.text,
                    completedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            
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

// 11. إعادة إرسال SMS
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

// 12. إلغاء الرقم واسترجاع الرصيد
app.post('/api/cancel-number', async (req, res) => {
    try {
        const { uid, activationId, refundAmount } = req.body;
        
        if (!uid) return res.status(400).json({ success: false, error: 'UID required' });
        if (!activationId) return res.status(400).json({ success: false, error: 'Activation ID required' });
        
        const refund = parseFloat(refundAmount) || 0;
        
        // إلغاء الرقم في HeroSMS
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=8`);
        
        if (response.data.includes('ACCESS_CANCEL') || response.data.includes('STATUS_CANCEL')) {
            // استرجاع الرصيد
            const newBalance = await addBalance(uid, refund, `استرجاع رصيد - إلغاء رقم ${activationId}`);
            
            // تحديث حالة التفعيل
            const activationsRef = db.collection('activations');
            const snapshot = await activationsRef.where('activationId', '==', activationId).get();
            snapshot.forEach(async (doc) => {
                await doc.ref.update({
                    status: 'cancelled',
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    refundAmount: refund
                });
            });
            
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

// 13. إنهاء التفعيل (بعد استلام الكود)
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

// 14. جلب التفعيلات النشطة
app.get('/api/active-activations', async (req, res) => {
    try {
        const { uid } = req.query;
        
        let query = db.collection('activations').where('status', '==', 'active');
        if (uid) {
            query = query.where('uid', '==', uid);
        }
        
        const snapshot = await query.orderBy('createdAt', 'desc').get();
        const activations = [];
        snapshot.forEach(doc => activations.push({ id: doc.id, ...doc.data() }));
        
        res.json({ success: true, activations });
    } catch (err) {
        // لو الـ collection مش موجودة، نرجع مصفوفة فاضية
        res.json({ success: true, activations: [] });
    }
});

// 15. حساب البونص للشحن
app.post('/api/calculate-bonus', async (req, res) => {
    try {
        const { amount } = req.body;
        
        let bonusPercent = 0;
        if (amount >= 1000) bonusPercent = 20;
        else if (amount >= 500) bonusPercent = 15;
        else if (amount >= 300) bonusPercent = 12;
        else if (amount >= 200) bonusPercent = 10;
        else if (amount >= 100) bonusPercent = 5;
        
        const bonus = amount * (bonusPercent / 100);
        const total = amount + bonus;
        
        res.json({
            success: true,
            amount,
            bonusPercent,
            bonus,
            total
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 16. تقديم طلب شحن رصيد
app.post('/api/submit-payment', async (req, res) => {
    try {
        const { uid, userEmail, amount, paymentMethod, phoneNumber, accountName } = req.body;
        
        if (!uid || !amount || !paymentMethod) {
            return res.status(400).json({ success: false, error: 'بيانات ناقصة' });
        }
        
        // حساب البونص
        let bonusPercent = 0;
        if (amount >= 1000) bonusPercent = 20;
        else if (amount >= 500) bonusPercent = 15;
        else if (amount >= 300) bonusPercent = 12;
        else if (amount >= 200) bonusPercent = 10;
        else if (amount >= 100) bonusPercent = 5;
        
        const bonus = amount * (bonusPercent / 100);
        const totalAmount = amount + bonus;
        
        // تحديد الحساب المستهدف
        const targetAccounts = {
            vodafone: { name: 'فودافون كاش', number: '01003050300', holder: 'شركة Simify' },
            instapay: { name: 'إنستا باي', number: 'simify@instapay', holder: 'شركة Simify' }
        };
        
        const targetAccount = targetAccounts[paymentMethod] || targetAccounts.vodafone;
        
        // حفظ طلب الدفع
        const paymentRequestRef = await db.collection('payment_requests').add({
            uid,
            userEmail,
            amount,
            bonus,
            totalAmount,
            paymentMethod,
            phoneNumber,
            accountName,
            targetAccount: targetAccount.number,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // حفظ في سجل العمليات
        await db.collection('transactions').add({
            uid,
            userEmail,
            type: 'credit',
            amount: totalAmount,
            paymentMethod,
            description: `طلب شحن رصيد عبر ${targetAccount.name}`,
            status: 'pending',
            paymentRequestId: paymentRequestRef.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({
            success: true,
            message: 'تم استلام طلبك وسيتم مراجعته خلال 30 دقيقة',
            requestId: paymentRequestRef.id,
            targetAccount
        });
        
    } catch (err) {
        console.error('Submit payment error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = app;
