// MCP Registry Landing Page JavaScript

document.addEventListener('DOMContentLoaded', function() {
  // Smooth scrolling for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      
      const targetId = this.getAttribute('href');
      if(targetId === '#') return;
      
      const targetElement = document.querySelector(targetId);
      if(targetElement) {
        window.scrollTo({
          top: targetElement.offsetTop - 80, // Accounting for fixed header
          behavior: 'smooth'
        });
      }
    });
  });

  // Mobile menu toggle (for responsive design)
  const mobileMenuButton = document.getElementById('mobile-menu-button');
  const mobileMenu = document.getElementById('mobile-menu');
  
  if(mobileMenuButton && mobileMenu) {
    mobileMenuButton.addEventListener('click', function() {
      mobileMenu.classList.toggle('hidden');
    });
  }

  // Add animation classes to elements when they come into view
  const animateOnScroll = function() {
    const elements = document.querySelectorAll('.animate-on-scroll');
    
    elements.forEach(element => {
      const elementPosition = element.getBoundingClientRect().top;
      const windowHeight = window.innerHeight;
      
      if(elementPosition < windowHeight - 100) {
        element.classList.add('animated');
      }
    });
  };

  // Run on scroll
  window.addEventListener('scroll', animateOnScroll);
  // Run once on page load
  animateOnScroll();

  // Code snippet type effect
  const codeElements = document.querySelectorAll('.typing-effect');
  
  codeElements.forEach(element => {
    const text = element.textContent;
    element.textContent = '';
    element.classList.add('typing-animation');
    
    let i = 0;
    const typeEffect = setInterval(() => {
      if(i < text.length) {
        element.textContent += text.charAt(i);
        i++;
      } else {
        clearInterval(typeEffect);
        element.classList.remove('typing-animation');
      }
    }, 50);
  });

  // Add floating animation class to hero image
  const heroImage = document.querySelector('.hero-image');
  if(heroImage) {
    heroImage.classList.add('floating');
  }

  // Hide navigation on scroll down, show on scroll up
  let lastScrollTop = 0;
  const navbar = document.querySelector('nav');
  
  window.addEventListener('scroll', function() {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    if(scrollTop > lastScrollTop && scrollTop > 200) {
      // Scrolling down & not at the top
      navbar.style.transform = 'translateY(-100%)';
    } else {
      // Scrolling up or at the top
      navbar.style.transform = 'translateY(0)';
    }
    
    lastScrollTop = scrollTop;
  });

  // Feature hover effect
  const featureCards = document.querySelectorAll('.feature-card');
  
  featureCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
      this.classList.add('feature-hover');
    });
    
    card.addEventListener('mouseleave', function() {
      this.classList.remove('feature-hover');
    });
  });

  // Enable copy to clipboard for code samples
  const codeBlocks = document.querySelectorAll('.code-block');
  
  codeBlocks.forEach(block => {
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.innerHTML = '<i class="fas fa-copy"></i>';
    copyButton.title = 'Copy to clipboard';
    
    block.style.position = 'relative';
    block.appendChild(copyButton);
    
    copyButton.addEventListener('click', function() {
      const code = block.textContent;
      navigator.clipboard.writeText(code)
        .then(() => {
          copyButton.innerHTML = '<i class="fas fa-check"></i>';
          setTimeout(() => {
            copyButton.innerHTML = '<i class="fas fa-copy"></i>';
          }, 2000);
        })
        .catch(err => {
          console.error('Failed to copy: ', err);
        });
    });
  });
}); 