#!/bin/bash

# Fix package-lock.json sync issues

echo "🔧 Fixing package-lock.json sync issues..."

# Backup existing files
if [ -f package-lock.json ]; then
    cp package-lock.json package-lock.json.backup
    echo "📦 Backed up package-lock.json"
fi

if [ -f node_modules ]; then
    echo "🗑️  Removing node_modules..."
    rm -rf node_modules
fi

# Remove old lock file
if [ -f package-lock.json ]; then
    rm package-lock.json
    echo "🗑️  Removed old package-lock.json"
fi

# Clean npm cache
npm cache clean --force
echo "🧹 Cleaned npm cache"

# Install dependencies (this creates a fresh package-lock.json)
echo "📦 Installing dependencies..."
npm install

# Verify the installation worked
if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed successfully!"
    echo "✅ New package-lock.json generated"
    
    # Test TypeScript build
    echo "🔨 Testing TypeScript build..."
    npm run build
    
    if [ $? -eq 0 ]; then
        echo "✅ TypeScript build successful!"
        echo ""
        echo "🚀 Ready to deploy:"
        echo "   npm run deploy:aws"
        echo "   # or"  
        echo "   docker build -f aws/Dockerfile -t test ."
    else
        echo "❌ TypeScript build failed"
        exit 1
    fi
else
    echo "❌ npm install failed"
    if [ -f package-lock.json.backup ]; then
        echo "🔄 Restoring backup..."
        mv package-lock.json.backup package-lock.json
    fi
    exit 1
fi