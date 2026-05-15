# AISA Proxy Server

## Deploy على Railway
1. ارفع الملفين على GitHub repo
2. في Railway: New Project → Deploy from GitHub
3. أضف Variables:
   - GROQ_KEY = مفتاح Groq بتاعك
   - ADMIN_KEY = كلمة سرية صعبة

## إنشاء License Key
```
POST /admin/license/create
Header: x-admin-key: [ADMIN_KEY]
Body: { "plan":"pro", "site_url":"https://client.com", "customer_email":"client@email.com", "expires_months":1 }
```

## الباقات
- trial:    20 رسالة/يوم — 100/شهر
- pro:      200 رسالة/يوم — 3000/شهر ($14/شهر)
- lifetime: 500 رسالة/يوم — 10000/شهر ($69 مرة)
