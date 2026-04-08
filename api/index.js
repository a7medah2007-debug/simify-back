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

// ==================== الثوابت والإعدادات الافتراضية ====================
const DEFAULT_SETTINGS = {
    usdToEgp: 50,
    profitMargin: 20,
    minPrice: 10,
    popularServices: [
        { code: 'tg', name: 'Telegram' },
        { code: 'wa', name: 'WhatsApp' },
        { code: 'gm', name: 'Google/Gmail' },
        { code: 'fb', name: 'Facebook' },
        { code: 'ig', name: 'Instagram' },
        { code: 'ds', name: 'Discord' },
        { code: 'tw', name: 'Twitter/X' },
        { code: 'vk', name: 'VKontakte' },
        { code: 'nf', name: 'Netflix' },
        { code: 'sn', name: 'Snapchat' }
    ],
    preferredCountries: ['0', '12', '16', '21', '53', '73', '43', '78', '36', '86', '62', '31']
};

// مدة صلاحية الكاش (10 دقائق)
const CACHE_TTL = 10 * 60 * 1000;

// أسماء الدول بالعربية
const COUNTRY_NAMES = {
    '0': 'روسيا', '1': 'أوكرانيا', '2': 'كازاخستان', '3': 'الصين', '4': 'الفلبين',
    '5': 'ميانمار', '6': 'إندونيسيا', '7': 'ماليزيا', '8': 'كينيا', '10': 'فيتنام',
    '12': 'الولايات المتحدة', '13': 'إسرائيل', '15': 'بولندا', '16': 'إنجلترا',
    '21': 'مصر', '22': 'الهند', '31': 'جنوب أفريقيا', '36': 'كندا', '37': 'المغرب',
    '43': 'ألمانيا', '46': 'السويد', '48': 'هولندا', '52': 'تايلاند', '53': 'السعودية',
    '54': 'المكسيك', '56': 'إسبانيا', '58': 'الجزائر', '62': 'تركيا', '73': 'البرازيل',
    '78': 'فرنسا', '86': 'إيطاليا', '89': 'تونس', '95': 'الإمارات', '100': 'الكويت',
    '102': 'ليبيا', '111': 'قطر', '115': 'الأردن', '144': 'البحرين', '156': 'فلسطين'
};

// أسماء الخدمات بالعربية
const SERVICE_NAMES_AR = {
    'tg': 'تيليجرام', 'wa': 'واتساب', 'wb': 'واتساب بزنس', 'gm': 'جوجل', 'go': 'جوجل فويس',
    'fb': 'فيسبوك', 'ig': 'إنستجرام', 'tw': 'تويتر', 'vk': 'فكونتاكتي', 'ok': 'أودنوكلاسنيكي',
    'ds': 'ديسكورد', 'nf': 'نتفليكس', 'sn': 'سناب شات', 'im': 'إيمو', 'vi': 'فايبر',
    'me': 'لاين', 'pp': 'باي بال', 'ts': 'باي بال', 'py': 'بايونير', 'sk': 'سكريل',
    'am': 'أمازون', 'ub': 'أوبر', 'ly': 'ليفت', 'bv': 'بينانس', 'sf': 'سبوتيفاي',
    'ya': 'ياندكس', 'ml': 'مايل.رو', 'ma': 'ميل.كوم', 'ol': 'أوت لوك'
};

// أيقونات الخدمات
const SERVICE_ICONS = {
    'tg': 'paper-plane', 'wa': 'whatsapp', 'wb': 'whatsapp',
    'gm': 'google', 'go': 'google', 'fb': 'facebook', 'ig': 'instagram',
    'tw': 'twitter', 'vk': 'vk', 'ds': 'discord', 'nf': 'netflix',
    'sn': 'snapchat', 'pp': 'paypal', 'ts': 'paypal', 'am': 'amazon',
    'ub': 'uber', 'sf': 'spotify'
};

// ==================== دوال مساعدة ====================

// جلب الإعدادات من Firestore (مع تخزين مؤقت محلي لتقليل الاستدعاءات)
let cachedSettings = null;
let settingsLastFetch = 0;

async function getSettings() {
    const now = Date.now();
    
    // استخدام الكاش المحلي لمدة 30 ثانية
    if (cachedSettings && (now - settingsLastFetch) < 30000) {
        return cachedSettings;
    }
    
    try {
        const doc = await db.collection('settings').doc('pricing').get();
        if (doc.exists) {
            cachedSettings = { ...DEFAULT_SETTINGS, ...doc.data() };
        } else {
            await db.collection('settings').doc('pricing').set(DEFAULT_SETTINGS);
            cachedSettings = DEFAULT_SETTINGS;
        }
        settingsLastFetch = now;
        return cachedSettings;
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
    
    await db.collection('transactions').add({
        uid, type: 'debit', amount: -amount, description,
        status: 'completed', createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return currentBalance - amount;
}

// إضافة رصيد للمستخدم
async function addBalance(uid, amount, description) {
    const userRef = db.collection('users').doc(uid);
    await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
    
    await db.collection('transactions').add({
        uid, type: 'credit', amount, description,
        status: 'completed', createdAt: admin.firestore.FieldValue.serverTimestamp()
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

// الحصول على اسم الدولة بالعربية
function getCountryName(code) {
    return COUNTRY_NAMES[code] || `دولة ${code}`;
}

// الحصول على اسم الخدمة بالعربية
function getServiceNameAr(code) {
    return SERVICE_NAMES_AR[code] || code.toUpperCase();
}

// الحصول على أيقونة الخدمة
function getServiceIcon(code) {
    return SERVICE_ICONS[code] || 'globe';
}

// تحديث حالة التفعيل
async function updateActivationStatus(activationId, status, code = null, fullMessage = null) {
    try {
        const snapshot = await db.collection('activations').where('activationId', '==', activationId).get();
        const updateData = { status, completedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (code) updateData.code = code;
        if (fullMessage) updateData.fullMessage = fullMessage;
        snapshot.forEach(async (doc) => { await doc.ref.update(updateData); });
    } catch (e) {
        console.error('Error updating activation status:', e);
    }
}

// ==================== نظام الكاش للخدمات الشائعة ====================

// جلب بيانات الخدمات الشائعة من الكاش أو إنشائها
async function getCachedPopularServices(settings) {
    try {
        const cacheDoc = await db.collection('cache').doc('popular_services').get();
        
        if (cacheDoc.exists) {
            const data = cacheDoc.data();
            const cacheAge = Date.now() - (data.updatedAt?.toDate() || 0);
            
            // لو الكاش لسه صالح
            if (cacheAge < CACHE_TTL) {
                return { services: data.services, fromCache: true };
            }
        }
        
        return { services: null, fromCache: false };
    } catch (error) {
        console.error('Error getting cached services:', error);
        return { services: null, fromCache: false };
    }
}

// تحديث الكاش في الخلفية
async function updatePopularServicesCache(settings) {
    try {
        const popularServices = settings.popularServices || DEFAULT_SETTINGS.popularServices;
        const preferredCountries = settings.preferredCountries || DEFAULT_SETTINGS.preferredCountries;
        const services = [];
        
        // استخدام Promise.allSettled للتعامل مع الأخطاء بشكل أفضل
        const promises = popularServices.map(service => 
            fetchServiceWithRetry(service, preferredCountries, settings)
        );
        
        const results = await Promise.allSettled(promises);
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                services.push(result.value);
            } else {
                // إضافة خدمة فارغة في حالة الفشل
                const service = popularServices[index];
                services.push({
                    code: service.code,
                    name: service.name,
                    nameAr: getServiceNameAr(service.code),
                    icon: getServiceIcon(service.code),
                    countries: [],
                    totalCountries: 0,
                    minPrice: 0
                });
            }
        });
        
        // ترتيب الخدمات حسب الأقل سعراً
        services.sort((a, b) => a.minPrice - b.minPrice);
        
        // حفظ في الكاش
        await db.collection('cache').doc('popular_services').set({
            services,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log('✅ Popular services cache updated');
        return services;
        
    } catch (error) {
        console.error('Error updating popular services cache:', error);
        return null;
    }
}

// جلب خدمة مع إعادة المحاولة
async function fetchServiceWithRetry(service, preferredCountries, settings, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            const url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices&service=${service.code}`;
            const response = await axios.get(url, { timeout: 8000 });
            const pricesData = response.data;
            
            const countries = [];
            
            for (const countryCode of preferredCountries) {
                if (pricesData[countryCode] && pricesData[countryCode][service.code]) {
                    const countryData = pricesData[countryCode][service.code];
                    const usdPrice = countryData.cost || 0;
                    
                    if (usdPrice > 0 && countryData.count > 0) {
                        const egpPrice = await convertPrice(usdPrice);
                        countries.push({
                            code: countryCode,
                            name: getCountryName(countryCode),
                            priceUsd: usdPrice,
                            priceEgp: egpPrice,
                            count: countryData.count
                        });
                    }
                }
            }
            
            countries.sort((a, b) => a.priceEgp - b.priceEgp);
            
            return {
                code: service.code,
                name: service.name,
                nameAr: getServiceNameAr(service.code),
                icon: getServiceIcon(service.code),
                countries,
                totalCountries: countries.length,
                minPrice: countries.length > 0 ? countries[0].priceEgp : 0
            };
            
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

// ==================== API Endpoints ====================

// 1. فحص صحة السيرفر
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
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
        const updates = req.body;
        await db.collection('settings').doc('pricing').set(updates, { merge: true });
        
        // مسح الكاش المحلي للإعدادات
        cachedSettings = null;
        
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

// 5. أشهر الخدمات (نسخة محسّنة مع كاش)
app.get('/api/popular-services', async (req, res) => {
    try {
        const settings = await getSettings();
        
        // محاولة جلب البيانات من الكاش
        const cached = await getCachedPopularServices(settings);
        
        if (cached.services) {
            return res.json({
                success: true,
                services: cached.services,
                meta: {
                    usdToEgp: settings.usdToEgp,
                    profitMargin: settings.profitMargin,
                    totalServices: cached.services.length,
                    cached: true
                }
            });
        }
        
        // لو مفيش كاش، نرجع بيانات أساسية فوراً
        const basicServices = settings.popularServices.map(s => ({
            code: s.code,
            name: s.name,
            nameAr: getServiceNameAr(s.code),
            icon: getServiceIcon(s.code),
            countries: [],
            totalCountries: 0,
            minPrice: 0,
            loading: true
        }));
        
        res.json({
            success: true,
            services: basicServices,
            meta: {
                usdToEgp: settings.usdToEgp,
                profitMargin: settings.profitMargin,
                totalServices: basicServices.length,
                cached: false,
                loading: true
            }
        });
        
        // تحديث الكاش في الخلفية (بدون انتظار)
        updatePopularServicesCache(settings).catch(e => 
            console.error('Background cache update failed:', e)
        );
        
    } catch (err) {
        console.error('Popular services error:', err);
        
        // الرجوع للبيانات الافتراضية في حالة الخطأ
        const fallbackServices = DEFAULT_SETTINGS.popularServices.map(s => ({
            code: s.code,
            name: s.name,
            nameAr: getServiceNameAr(s.code),
            icon: getServiceIcon(s.code),
            countries: [
                { code: '12', name: 'الولايات المتحدة', priceEgp: 18, count: 10 },
                { code: '21', name: 'مصر', priceEgp: 8, count: 15 },
                { code: '53', name: 'السعودية', priceEgp: 14, count: 12 }
            ],
            totalCountries: 3,
            minPrice: 8
        }));
        
        res.json({
            success: true,
            services: fallbackServices,
            meta: { usdToEgp: 50, profitMargin: 20, cached: false, fallback: true }
        });
    }
});

// 6. كل الدول لخدمة معينة
app.get('/api/service-countries', async (req, res) => {
    try {
        const { service } = req.query;
        
        if (!service) {
            return res.status(400).json({ success: false, error: 'Service code required' });
        }
        
        const settings = await getSettings();
        const url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices&service=${service}`;
        const response = await axios.get(url, { timeout: 10000 });
        const pricesData = response.data;
        
        const countries = [];
        
        for (const [countryCode, services] of Object.entries(pricesData)) {
            if (services[service] && typeof services[service].cost === 'number') {
                const data = services[service];
                const usdPrice = data.cost || 0;
                
                if (usdPrice > 0 && data.count > 0) {
                    const egpPrice = await convertPrice(usdPrice);
                    countries.push({
                        code: countryCode,
                        name: getCountryName(countryCode),
                        priceUsd: usdPrice,
                        priceEgp: egpPrice,
                        count: data.count
                    });
                }
            }
        }
        
        countries.sort((a, b) => a.priceEgp - b.priceEgp);
        
        res.json({
            success: true,
            service: {
                code: service,
                nameAr: getServiceNameAr(service),
                icon: getServiceIcon(service)
            },
            countries,
            total: countries.length,
            meta: {
                usdToEgp: settings.usdToEgp,
                profitMargin: settings.profitMargin
            }
        });
        
    } catch (err) {
        console.error('Service countries error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. جلب قائمة الدول
app.get('/api/countries', async (req, res) => {
    try {
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getCountries`, { timeout: 10000 });
        res.json({ success: true, countries: response.data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. جلب قائمة الخدمات (كل الخدمات)
app.get('/api/services', async (req, res) => {
    try {
        const { country } = req.query;
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getServicesList`;
        if (country) url += `&country=${country}`;
        
        const response = await axios.get(url, { timeout: 10000 });
        let services = [];
        
        if (response.data?.services) {
            services = response.data.services;
        } else if (Array.isArray(response.data)) {
            services = response.data;
        }
        
        services = services.map(s => ({
            ...s,
            nameAr: getServiceNameAr(s.code),
            icon: getServiceIcon(s.code)
        }));
        
        res.json({ success: true, services });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. جلب الأسعار (مع التحويل للمصري)
app.get('/api/prices', async (req, res) => {
    try {
        const { service, country } = req.query;
        const settings = await getSettings();
        
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices`;
        if (service) url += `&service=${service}`;
        if (country) url += `&country=${country}`;
        
        const response = await axios.get(url, { timeout: 10000 });
        const pricesData = response.data;
        
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

// 10. جلب سعر خدمة في دولة محددة
app.get('/api/price', async (req, res) => {
    try {
        const { service, country } = req.query;
        if (!service || !country) {
            return res.status(400).json({ success: false, error: 'Service and country required' });
        }
        
        const url = `${HERO_URL}?api_key=${HERO_KEY}&action=getPrices&service=${service}&country=${country}`;
        const response = await axios.get(url, { timeout: 8000 });
        const pricesData = response.data;
        
        let usdPrice = 0;
        if (pricesData[country] && pricesData[country][service]) {
            usdPrice = pricesData[country][service].cost || 0;
        }
        
        const egpPrice = await convertPrice(usdPrice);
        const settings = await getSettings();
        
        res.json({ 
            success: true, 
            price: { usd: usdPrice, egp: egpPrice },
            meta: { exchangeRate: settings.usdToEgp, profitMargin: settings.profitMargin }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 11. طلب رقم جديد
app.get('/api/get-number', async (req, res) => {
    try {
        const { uid, service, country, maxPrice } = req.query;
        
        if (!uid || !service || !country) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        let url = `${HERO_URL}?api_key=${HERO_KEY}&action=getNumberV2&service=${service}&country=${country}`;
        if (maxPrice) url += `&maxPrice=${maxPrice}`;
        
        const response = await axios.get(url, { timeout: 15000 });
        const data = response.data;
        
        if (typeof data === 'string') {
            const errorMessages = {
                'NO_BALANCE': 'رصيد HeroSMS غير كافي',
                'NO_NUMBERS': 'لا توجد أرقام متاحة حالياً',
                'BAD_SERVICE': 'الخدمة غير صحيحة',
                'WRONG_COUNTRY': 'الدولة غير صحيحة'
            };
            const errorKey = Object.keys(errorMessages).find(key => data.includes(key));
            const errorMessage = errorKey ? errorMessages[errorKey] : data;
            return res.status(400).json({ success: false, error: errorMessage });
        }
        
        const usdCost = data.activationCost || 0;
        const egpCost = await convertPrice(usdCost);
        
        const currentBalance = await getUserBalance(uid);
        if (currentBalance < egpCost) {
            try {
                await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${data.activationId}&status=8`);
            } catch (e) {}
            return res.status(402).json({ success: false, error: 'رصيدك غير كافي' });
        }
        
        const newBalance = await deductBalance(uid, egpCost, `شراء رقم ${service} - ${data.phoneNumber}`);
        
        await db.collection('activations').add({
            uid, service, country,
            activationId: data.activationId,
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
            remainingBalance: newBalance,
            meta: { exchangeRate: settings.usdToEgp, profit: settings.profitMargin }
        });
        
    } catch (err) {
        console.error('Get number error:', err);
        res.status(500).json({ success: false, error: 'حصلت مشكلة في السيرفر' });
    }
});

// 12. فحص وجود كود
app.get('/api/get-sms', async (req, res) => {
    try {
        const { activationId } = req.query;
        if (!activationId) return res.status(400).json({ success: false, error: 'Activation ID required' });
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=getStatusV2&id=${activationId}`, { timeout: 8000 });
        const data = response.data;
        
        if (typeof data === 'string') {
            if (data.includes('STATUS_OK')) {
                const code = data.split(':')[1];
                await updateActivationStatus(activationId, 'completed', code);
                return res.json({ success: true, code, status: 'received' });
            }
            if (data === 'STATUS_WAIT_CODE') return res.json({ success: false, status: 'waiting' });
            if (data === 'STATUS_CANCEL') return res.json({ success: false, status: 'cancelled' });
            return res.json({ success: false, status: 'unknown' });
        }
        
        if (data.sms?.code) {
            await updateActivationStatus(activationId, 'completed', data.sms.code, data.sms.text);
            return res.json({ success: true, code: data.sms.code, text: data.sms.text, type: 'sms' });
        }
        
        if (data.call?.code) {
            return res.json({ success: true, code: data.call.code, text: data.call.text, type: 'call' });
        }
        
        res.json({ success: false, status: 'waiting' });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 13. إعادة إرسال SMS
app.post('/api/resend-sms', async (req, res) => {
    try {
        const { activationId } = req.body;
        if (!activationId) return res.status(400).json({ success: false, error: 'Activation ID required' });
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=3`, { timeout: 8000 });
        res.json({ success: response.data.includes('ACCESS_RETRY_GET'), message: 'تم طلب إعادة الإرسال' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 14. إلغاء الرقم واسترجاع الرصيد
app.post('/api/cancel-number', async (req, res) => {
    try {
        const { uid, activationId, refundAmount } = req.body;
        if (!uid || !activationId) return res.status(400).json({ success: false, error: 'Missing fields' });
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=8`, { timeout: 8000 });
        
        if (response.data.includes('ACCESS_CANCEL') || response.data.includes('STATUS_CANCEL')) {
            const refund = parseFloat(refundAmount) || 0;
            const newBalance = await addBalance(uid, refund, `استرجاع رصيد - إلغاء رقم ${activationId}`);
            
            const snapshot = await db.collection('activations').where('activationId', '==', activationId).get();
            snapshot.forEach(async (doc) => {
                await doc.ref.update({ 
                    status: 'cancelled', 
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(), 
                    refundAmount: refund 
                });
            });
            
            res.json({ success: true, message: 'تم الإلغاء واسترداد الرصيد', newBalance });
        } else {
            res.json({ success: false, error: response.data });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 15. إنهاء التفعيل
app.post('/api/complete-activation', async (req, res) => {
    try {
        const { activationId } = req.body;
        if (!activationId) return res.status(400).json({ success: false, error: 'Activation ID required' });
        
        const response = await axios.get(`${HERO_URL}?api_key=${HERO_KEY}&action=setStatus&id=${activationId}&status=6`, { timeout: 8000 });
        res.json({ success: response.data.includes('ACCESS_ACTIVATION'), message: 'تم إنهاء التفعيل' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 16. جلب التفعيلات النشطة
app.get('/api/active-activations', async (req, res) => {
    try {
        const { uid } = req.query;
        let query = db.collection('activations').where('status', '==', 'active');
        if (uid) query = query.where('uid', '==', uid);
        
        const snapshot = await query.orderBy('createdAt', 'desc').get();
        const activations = [];
        snapshot.forEach(doc => activations.push({ id: doc.id, ...doc.data() }));
        res.json({ success: true, activations });
    } catch (err) {
        res.json({ success: true, activations: [] });
    }
});

// 17. حساب البونص
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
        res.json({ success: true, amount, bonusPercent, bonus, total: amount + bonus });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 18. تقديم طلب شحن
app.post('/api/submit-payment', async (req, res) => {
    try {
        const { uid, userEmail, amount, paymentMethod, phoneNumber, accountName } = req.body;
        if (!uid || !amount || !paymentMethod) {
            return res.status(400).json({ success: false, error: 'بيانات ناقصة' });
        }
        
        let bonusPercent = 0;
        if (amount >= 1000) bonusPercent = 20;
        else if (amount >= 500) bonusPercent = 15;
        else if (amount >= 300) bonusPercent = 12;
        else if (amount >= 200) bonusPercent = 10;
        else if (amount >= 100) bonusPercent = 5;
        
        const bonus = amount * (bonusPercent / 100);
        const totalAmount = amount + bonus;
        
        const targetAccounts = {
            vodafone: { name: 'فودافون كاش', number: '01003050300', holder: 'Simify' },
            instapay: { name: 'إنستا باي', number: 'simify@instapay', holder: 'Simify' }
        };
        
        const targetAccount = targetAccounts[paymentMethod] || targetAccounts.vodafone;
        
        const paymentRequestRef = await db.collection('payment_requests').add({
            uid, userEmail, amount, bonus, totalAmount, paymentMethod,
            phoneNumber, accountName, targetAccount: targetAccount.number,
            status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        await db.collection('transactions').add({
            uid, userEmail, type: 'credit', amount: totalAmount,
            paymentMethod, description: `طلب شحن عبر ${targetAccount.name}`,
            status: 'pending', paymentRequestId: paymentRequestRef.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true, message: 'تم استلام طلبك', requestId: paymentRequestRef.id, targetAccount });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 19. مسح الكاش يدوياً (للاستخدام الإداري)
app.post('/api/clear-cache', async (req, res) => {
    try {
        await db.collection('cache').doc('popular_services').delete();
        cachedSettings = null;
        res.json({ success: true, message: 'تم مسح الكاش بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = app;
