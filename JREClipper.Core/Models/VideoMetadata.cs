// JREClipper.Core/Models/VideoMetadata.cs

namespace JREClipper.Core.Models
{
    public class VideoMetadata
    {
        public string VideoId { get; set; }
        public string Title { get; set; }
        public DateTime PublishedDate { get; set; }
        public string ChannelName { get; set; } // Added to match CSV
        public string? GuestName { get; set; } // Added to match CSV
        public string? Tags { get; set; } // Added to match CSV
        public int? EpisodeNumber { get; set; } // Added to match CSV
    }
}
