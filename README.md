<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bonus Registration & Task System</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 font-sans antialiased pb-20">

    <!-- Header Section -->
    <header class="bg-blue-600 text-white p-4 text-center shadow-md">
        <h1 class="text-xl font-bold flex items-center justify-center gap-2">
            <!-- Gift Icon (Tap 5 times for Admin PIN as per README) -->
            <span id="giftIcon" class="cursor-pointer select-none" title="Admin Login">🎁</span> 
            Bonus Registration
        </h1>
        <p class="text-xs text-blue-100">৳১০০ Welcome Bonus & Live Location Security</p>
    </header>

    <!-- Main Container -->
    <main class="max-w-md mx-auto p-4">

        <!-- Tab Switcher Navigation -->
        <div class="flex bg-white rounded-lg shadow-sm p-1 mb-4 border border-gray-200">
            <button onclick="switchTab('home')" id="btnHomeTab" class="flex-1 py-2 text-center font-semibold rounded-md bg-blue-600 text-white transition text-sm">Registration / Home</button>
            <button onclick="switchTab('tasks')" id="btnTaskTab" class="flex-1 py-2 text-center font-semibold rounded-md text-gray-600 transition text-sm">Tasks & Rewards</button>
        </div>

        <!-- SECTION 1: Original Registration & Location Flow -->
        <section id="homeSection" class="space-y-4">
            <div class="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
                <h2 class="text-lg font-bold text-gray-800 mb-2">রেজিস্ট্রেশন ফরম</h2>
                <p class="text-xs text-gray-500 mb-4">বিকাশ/নগদ নম্বর দিয়ে একাউন্ট তৈরি করুন এবং লোকেশন পারমিশন দিন।</p>
                
                <!-- Registration Form Elements (As per your original code) -->
                <div class="space-y-3">
                    <div>
                        <label class="block text-xs font-semibold text-gray-600 mb-1">bKash / Nagad Number</label>
                        <input type="text" id="phoneInput" placeholder="017xxxxxxxx" class="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    </div>
                    
                    <div class="flex items-center gap-2 mt-2">
                        <input type="checkbox" id="consentCheckbox" class="w-4 h-4 text-blue-600 rounded">
                        <label for="consentCheckbox" class="text-xs text-gray-600">I agree to privacy policy & location sharing consent.</label>
                    </div>

                    <button onclick="handleRegister()" class="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold text-sm shadow hover:bg-blue-700 transition mt-3">
                        CREATE ACCOUNT / Register
                    </button>
                </div>
            </div>
        </section>

        <!-- SECTION 2: New Task System Area -->
        <section id="taskSection" class="space-y-3 hidden">
            
            <!-- Daily Check-in -->
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                <div>
                    <h3 class="font-bold text-gray-800 text-sm">📅 Daily Check-in</h3>
                    <p class="text-xs text-gray-500">প্রতিদিনের ফ্রি বোনাস পয়েন্ট নিন</p>
                </div>
                <button onclick="claimDailyCheckIn()" class="bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow hover:bg-green-700">Claim</button>
            </div>

            <!-- Referral Task -->
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                <div>
                    <h3 class="font-bold text-gray-800 text-sm">👥 Referral Task</h3>
                    <p class="text-xs text-gray-500">বন্ধুদের ইনভাইট করে আয় করুন</p>
                </div>
                <button onclick="shareReferralLink()" class="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow hover:bg-blue-700">Share</button>
            </div>

            <!-- Watch Video / Visit Link Task -->
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                <div>
                    <h3 class="font-bold text-gray-800 text-sm">▶️ Watch & Visit Task</h3>
                    <p class="text-xs text-gray-500">লিংক ভিজিট বা ভিডিও দেখে রিওয়ার্ড পান</p>
                </div>
                <button onclick="startVisitTask()" class="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow hover:bg-purple-700">Start</button>
            </div>

        </section>

    </main>

    <!-- Bottom Navigation Bar for Mobile Feel -->
    <nav class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex justify-around py-2 shadow-lg max-w-md mx-auto">
        <button onclick="switchTab('home')" class="flex flex-col items-center text-blue-600 focus:outline-none">
            <span class="text-lg">🏠</span>
            <span class="text-[10px] font-medium">Home</span>
        </button>
        <button onclick="switchTab('tasks')" class="flex flex-col items-center text-gray-500 focus:outline-none">
            <span class="text-lg">📋</span>
            <span class="text-[10px] font-medium">Tasks</span>
        </button>
    </nav>

    <!-- JavaScript Actions & Logic -->
    <script>
        // Tab Switcher
        function switchTab(tab) {
            const homeSec = document.getElementById('homeSection');
            const taskSec = document.getElementById('taskSection');
            const btnHome = document.getElementById('btnHomeTab');
            const btnTask = document.getElementById('btnTaskTab');

            if (tab === 'home') {
                homeSec.classList.remove('hidden');
                taskSec.classList.add('hidden');
                btnHome.className = "flex-1 py-2 text-center font-semibold rounded-md bg-blue-600 text-white transition text-sm";
                btnTask.className = "flex-1 py-2 text-center font-semibold rounded-md text-gray-600 transition text-sm";
            } else {
                homeSec.classList.add('hidden');
                taskSec.classList.remove('hidden');
                btnTask.className = "flex-1 py-2 text-center font-semibold rounded-md bg-blue-600 text-white transition text-sm";
                btnHome.className = "flex-1 py-2 text-center font-semibold rounded-md text-gray-600 transition text-sm";
            }
        }

        // Register button location flow implementation as specified in README
        function handleRegister() {
            const phone = document.getElementById('phoneInput').value;
            const consent = document.getElementById('consentCheckbox').checked;

            if(!phone) {
                alert('দয়া করে আপনার বিকাশ/নগদ নম্বর লিখুন।');
                return;
            }
            if(!consent) {
                alert('দয়া করে প্রাইভেসি পলিসি ও কনসেন্ট বক্সে টিক দিন।');
                return;
            }

            // Browser Geolocation Prompt Trigger (As stated in README flow)
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        const lat = position.coords.latitude;
                        const lon = position.coords.longitude;
                        alert('Location allowed! Registration successful with Location: ' + lat.toFixed(4) + ', ' + lon.toFixed(4));
                        // Here you can send data to your server.js backend
                    },
                    (error) => {
                        alert('Registration stops! Location permission is required to continue.');
                    }
                );
            } else {
                alert('Geolocation is not supported by your browser.');
            }
        }

        // Gift Icon 5 times click listener for Admin PIN (README feature)
        let giftClickCount = 0;
        document.getElementById('giftIcon').addEventListener('click', () => {
            giftClickCount++;
            if (giftClickCount >= 5) {
                giftClickCount = 0;
                const pin = prompt('Enter Admin PIN:');
                if(pin) {
                    // Send PIN to server or handle admin auth
                    alert('Admin PIN entered: ' + pin);
                }
            }
        });

        // Task System Actions
        function claimDailyCheckIn() {
            alert('অভিনন্দন! আপনার দৈনিক চেক-ইন বোনাস সফলভাবে যোগ হয়েছে।');
        }

        function shareReferralLink() {
            if (navigator.share) {
                navigator.share({
                    title: 'Bonus Registration',
                    text: 'এই অ্যাপে জয়েন করুন এবং ফ্রি বোনাস নিন!',
                    url: window.location.href,
                }).catch(() => {});
            } else {
                alert('রেফারেল লিংক কপি করা হয়েছে!');
            }
        }

        function startVisitTask() {
            alert('টাস্ক লিংক ওপেন হচ্ছে...');
        }
    </script>
</body>
</html>
