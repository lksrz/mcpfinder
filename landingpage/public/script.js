// Mobile menu toggle
document.addEventListener('DOMContentLoaded', function() {
  const mobileMenuButton = document.getElementById('mobile-menu-button');
  const mobileMenu = document.getElementById('mobile-menu');
  
  if (mobileMenuButton && mobileMenu) {
    mobileMenuButton.addEventListener('click', function() {
      mobileMenu.classList.toggle('hidden');
    });
  }

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      
      const targetElement = document.querySelector(targetId);
      if (targetElement) {
        window.scrollTo({
          top: targetElement.offsetTop - 80, // Account for fixed header
          behavior: 'smooth'
        });
        
        // Close mobile menu if open
        if (mobileMenu) {
          mobileMenu.classList.add('hidden');
        }
      }
    });
  });

  // Feature card hover effect enhancement
  const featureCards = document.querySelectorAll('.feature-card');
  featureCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
      this.classList.add('shadow-lg');
      const icon = this.querySelector('.w-12');
      if (icon) {
        icon.classList.add('scale-110');
        icon.style.transition = 'transform 0.3s ease-in-out';
      }
    });
    
    card.addEventListener('mouseleave', function() {
      this.classList.remove('shadow-lg');
      const icon = this.querySelector('.w-12');
      if (icon) {
        icon.classList.remove('scale-110');
      }
    });
  });

  // Add "typing" animation to code blocks for visual interest
  const codeBlocks = document.querySelectorAll('.code-block');
  codeBlocks.forEach(block => {
    // Only apply if not on mobile (performance)
    if (window.innerWidth > 768) {
      const lines = block.querySelectorAll('div');
      lines.forEach((line, index) => {
        // Store original content and empty the line
        const originalContent = line.innerHTML;
        line.innerHTML = '';
        line.style.opacity = '0';

        // Add a slight delay based on line position (sequential reveal)
        setTimeout(() => {
          line.style.opacity = '1';
          let i = 0;
          const type = () => {
            // Gradually add content back (typing effect)
            if (i < originalContent.length) {
              line.innerHTML = originalContent.substring(0, i+1);
              i++;
              setTimeout(type, Math.random() * 10 + 5); // Variable speed for realistic typing
            } else {
              line.innerHTML = originalContent; // Ensure complete content is shown
            }
          };
          setTimeout(type, 50);
        }, 150 * index);
      });
    }
  });

  // API Tab functionality (if present)
  const apiTabs = document.querySelectorAll('[data-api-tab]');
  const apiContents = document.querySelectorAll('[data-api-content]');
  
  if (apiTabs.length > 0) {
    apiTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-api-tab');
        
        // Hide all content
        apiContents.forEach(content => {
          content.classList.add('hidden');
        });
        
        // Deactivate all tabs
        apiTabs.forEach(tab => {
          tab.classList.remove('bg-primary-600', 'text-white');
          tab.classList.add('bg-gray-100', 'text-gray-800');
        });
        
        // Show target content
        document.querySelector(`[data-api-content="${target}"]`).classList.remove('hidden');
        
        // Activate selected tab
        tab.classList.remove('bg-gray-100', 'text-gray-800');
        tab.classList.add('bg-primary-600', 'text-white');
      });
    });
  }
});

// Add intersection observer for scroll animations
document.addEventListener('DOMContentLoaded', function() {
  // Create the observer
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('animate-fade-in');
        observer.unobserve(entry.target);
      }
    });
  }, {
    root: null,
    threshold: 0.1,
    rootMargin: '0px'
  });
  
  // Add fade-in class and style
  const fadeStyle = document.createElement('style');
  fadeStyle.innerHTML = `
    .animate-fade-in {
      opacity: 1;
      transform: translateY(0);
      transition: opacity 0.6s ease-out, transform 0.6s ease-out;
    }
    .fade-item {
      opacity: 0;
      transform: translateY(20px);
    }
  `;
  document.head.appendChild(fadeStyle);
  
  // Target elements to animate
  const animationTargets = [
    'h2',
    '.feature-card',
    '.code-window',
    '.glass'
  ];
  
  // Add fade-item class to all targets
  animationTargets.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el, i) => {
      el.classList.add('fade-item');
      el.style.transitionDelay = `${i * 0.1}s`;
      observer.observe(el);
    });
  });
}); 